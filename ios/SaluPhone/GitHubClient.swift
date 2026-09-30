import Foundation

enum SaluError: LocalizedError {
    case http(Int, String)
    case notConfigured
    var errorDescription: String? {
        switch self {
        case .http(let code, let msg): return "GitHub said \(code): \(msg)"
        case .notConfigured: return "Add your repository and token in Settings."
        }
    }
}

/// Talks to the project's git remote through the GitHub contents API. No salu server involved.
struct GitHubClient {
    let owner: String
    let repo: String
    let token: String
    static let branch = "salu/inbox"

    private func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        var r = URLRequest(url: URL(string: "https://api.github.com/repos/\(owner)/\(repo)/\(path)")!)
        r.httpMethod = method
        r.httpBody = body
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, resp) = try await URLSession.shared.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw SaluError.http(code, String(data: data, encoding: .utf8)?.prefix(200).description ?? "")
        }
        return data
    }

    private struct Entry: Decodable { let name: String; let path: String }
    private struct FileBody: Decodable { let content: String }

    /// Newest first. Files are write-once, so `known` ids never need fetching again.
    func messages(known: [String: SaluMessage]) async throws -> [SaluMessage] {
        let listing: [Entry]
        do {
            listing = try JSONDecoder().decode([Entry].self, from: try await request("contents/salu-inbox/messages?ref=\(Self.branch)"))
        } catch SaluError.http(404, _) {
            return []  // the box has not sent anything yet
        }
        var out: [SaluMessage] = []
        for e in listing where e.name.hasSuffix(".json") {
            let id = String(e.name.dropLast(5))
            if let m = known[id] { out.append(m); continue }
            let f = try JSONDecoder().decode(FileBody.self, from: try await request("contents/\(e.path)?ref=\(Self.branch)"))
            let raw = Data(base64Encoded: f.content.replacingOccurrences(of: "\n", with: "")) ?? Data()
            if let m = try? JSONDecoder().decode(SaluMessage.self, from: raw), m.v == 1 { out.append(m) }
        }
        return out.sorted { $0.id > $1.id }
    }

    func send(_ t: SaluTicket) async throws {
        let json = try JSONEncoder().encode(t)
        let payload: [String: Any] = [
            "message": "salu ticket \(t.id)",
            "content": json.base64EncodedString(),
            "branch": Self.branch,
        ]
        _ = try await request("contents/salu-inbox/tickets/\(t.id).json", method: "PUT", body: try JSONSerialization.data(withJSONObject: payload))
    }
}

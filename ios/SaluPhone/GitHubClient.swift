import CryptoKit
import Foundation

enum SaluError: LocalizedError {
    case http(Int, String)
    case notConfigured
    case badRepo
    var errorDescription: String? {
        switch self {
        case .http(401, _): return "GitHub refused the token. Check it in Settings."
        case .http(403, _): return "The token can't reach this repo. It needs Contents read and write on it."
        case .http(404, _): return "GitHub can't find that repo. Check owner/name, and that the token covers it."
        case .http(409, _): return Self.noInbox
        case .http(422, let msg) where msg.localizedCaseInsensitiveContains("branch"): return Self.noInbox
        case .http(let code, let msg): return "GitHub said \(code): \(msg)"
        case .notConfigured: return "Add your repository, token and signing key in Settings."
        case .badRepo: return "Write the repo as owner/name."
        }
    }
    private static let noInbox = "The repo has no salu/inbox branch yet. Run `salu remote add` on your computer first."
}

/// Talks to the project's git remote through the GitHub contents API. No salu server involved.
struct GitHubClient {
    let owner: String
    let repo: String
    let token: String
    let key: SymmetricKey  // inbox signing: the box ignores unsigned files
    static let branch = "salu/inbox"
    static let maxFileBytes = 64 * 1024  // MAX_FILE_BYTES in format.ts

    /// `owner/name` from what someone typed or pasted: `owner/name`, a github.com URL, or an ssh remote.
    static func parseRepo(_ text: String) -> (owner: String, repo: String)? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["https://github.com/", "http://github.com/", "github.com/", "git@github.com:"] where s.lowercased().hasPrefix(prefix) {
            s = String(s.dropFirst(prefix.count))
        }
        if s.hasSuffix("/") { s.removeLast() }
        if s.hasSuffix(".git") { s.removeLast(4) }
        let parts = s.split(separator: "/").map(String.init)
        let ok = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        guard parts.count == 2, parts.allSatisfy({ part in !part.isEmpty && part.unicodeScalars.allSatisfy({ ok.contains($0) }) }) else { return nil }
        return (parts[0], parts[1])
    }

    private func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        guard let url = URL(string: "https://api.github.com/repos/\(owner)/\(repo)" + (path.isEmpty ? "" : "/\(path)")) else {
            throw SaluError.badRepo
        }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.httpBody = body
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        r.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await URLSession.shared.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw SaluError.http(code, String(data: data, encoding: .utf8)?.prefix(200).description ?? "")
        }
        return data
    }

    private struct Entry: Decodable { let name: String; let path: String; let type: String; let size: Int }
    private struct FileBody: Decodable { let content: String }

    /// Newest first. Files are write-once, so `known` ids never need fetching again, and `rejected` ones
    /// (unsigned or badly signed while a key is set) are not fetched again either; the second value
    /// is the updated rejected set.
    func messages(known: [String: SaluMessage], rejected: Set<String>) async throws -> ([SaluMessage], Set<String>) {
        let listing: [Entry]
        do {
            listing = try JSONDecoder().decode([Entry].self, from: try await request("contents/salu-inbox/messages?ref=\(Self.branch)"))
        } catch SaluError.http(404, _) {
            return ([], rejected)  // the box has not sent anything yet
        }
        var out: [SaluMessage] = []
        var bad = rejected
        var seen = Set<String>()  // a file's id comes from its content: never list one twice
        // like the CLI: only regular files, never symlinks, nothing over 64 KB
        for e in listing where e.name.hasSuffix(".json") && e.type == "file" && e.size <= Self.maxFileBytes {
            let id = String(e.name.dropLast(5))
            if let m = known[id] {
                if seen.insert(m.id).inserted { out.append(m) }
                continue
            }
            if bad.contains(id) { continue }
            let path = e.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""  // a name from the remote: keep ? and # out of the URL
            let data = try await request("contents/\(path)?ref=\(Self.branch)")  // network errors still fail the refresh
            guard let f = try? JSONDecoder().decode(FileBody.self, from: data) else {
                bad.insert(id)  // not a readable file (a submodule lists as one too)
                continue
            }
            let raw = Data(base64Encoded: f.content.replacingOccurrences(of: "\n", with: "")) ?? Data()
            guard raw.count <= Self.maxFileBytes, Signing.verify(raw, key: key) else {
                bad.insert(id)
                continue
            }
            if let m = try? JSONDecoder().decode(SaluMessage.self, from: raw), m.v == 1, seen.insert(m.id).inserted { out.append(m) }
        }
        bad.formIntersection(listing.map { String($0.name.dropLast(5)) })  // forget files the box removed
        return (out.sorted { $0.id > $1.id }, bad)
    }

    func send(_ t: SaluTicket) async throws {
        let json = try Signing.encode(t, key: key)
        let payload: [String: Any] = [
            "message": "salu ticket \(t.id)",
            "content": json.base64EncodedString(),
            "branch": Self.branch,
        ]
        _ = try await request("contents/salu-inbox/tickets/\(t.id).json", method: "PUT", body: try JSONSerialization.data(withJSONObject: payload))
    }

    func send(_ r: SaluReply) async throws {
        let json = try Signing.encode(r, key: key)
        let payload: [String: Any] = [
            "message": "salu reply \(r.id)",
            "content": json.base64EncodedString(),
            "branch": Self.branch,
        ]
        _ = try await request("contents/salu-inbox/replies/\(r.id).json", method: "PUT", body: try JSONSerialization.data(withJSONObject: payload))
    }

    func send(_ r: SaluResolve) async throws {
        let json = try Signing.encode(r, key: key)
        let payload: [String: Any] = [
            "message": "salu resolve \(r.id)",
            "content": json.base64EncodedString(),
            "branch": Self.branch,
        ]
        _ = try await request("contents/salu-inbox/resolves/\(r.id).json", method: "PUT", body: try JSONSerialization.data(withJSONObject: payload))
    }

    /// Settings' connection test. Throws when the token can't see the repo; returns whether the box
    /// has made the salu/inbox branch yet.
    func check() async throws -> Bool {
        _ = try await request("")
        do {
            _ = try await request("branches/\(Self.branch)")
            return true
        } catch SaluError.http(404, _) {
            return false
        }
    }
}

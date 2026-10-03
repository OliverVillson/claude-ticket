import CryptoKit
import Foundation

enum SaluError: LocalizedError {
    case http(Int, String)
    case notConfigured
    case badRepo
    var errorDescription: String? {
        switch self {
        case .http(401, _): return "GitHub refused the token. Check it in Settings."
        case .http(403, let msg) where msg.localizedCaseInsensitiveContains("rate limit"),
             .http(429, let msg) where msg.localizedCaseInsensitiveContains("rate limit"):
            return "GitHub's rate limit is used up for now. It resets within the hour."
        case .http(403, _): return "The token can't reach this repo. It needs Contents read and write on it."
        case .http(404, let msg) where msg.localizedCaseInsensitiveContains("branch"): return Self.noInbox
        case .http(404, _): return "GitHub can't find that repo. Check owner/name, and that the token covers it."
        case .http(422, let msg) where msg.localizedCaseInsensitiveContains("branch"): return Self.noInbox
        case .http(let code, let msg): return "GitHub said \(code): \(msg)"
        case .notConfigured: return "Add your repository, token and signing key in Settings."
        case .badRepo: return "Write the repo as owner/name."
        }
    }
    private static let noInbox = "The repo has no salu/inbox branch yet. Run `salu remote add` on your computer first."
}

/// Talks to the project's git remote through the GitHub contents API. No salu server involved.
/// Only constants inside, so it is safe to use from several tasks at once.
struct GitHubClient: @unchecked Sendable {
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

    private struct Entry: Decodable, Sendable { let name: String; let path: String; let type: String; let size: Int }
    private struct FileBody: Decodable { let content: String }

    /// One message file, read: a message, or not one the phone can use (unsigned, bad, unreadable).
    private enum Fetched: Sendable {
        case message(SaluMessage)
        case bad
    }

    private func fetch(_ e: Entry) async throws -> Fetched {
        let path = e.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""  // a name from the remote: keep ? and # out of the URL
        let data = try await request("contents/\(path)?ref=\(Self.branch)")  // network errors still fail the refresh
        guard let f = try? JSONDecoder().decode(FileBody.self, from: data) else { return .bad }  // a submodule lists as a file too
        let raw = Data(base64Encoded: f.content.replacingOccurrences(of: "\n", with: "")) ?? Data()
        guard raw.count <= Self.maxFileBytes, Signing.verify(raw, key: key),
              let m = try? JSONDecoder().decode(SaluMessage.self, from: raw), m.v == 1 else { return .bad }
        return .message(m)
    }

    /// Newest first. Files are write-once, so `known` ids never need fetching again, and `rejected` ones
    /// (unsigned or badly signed while a key is set) are not fetched again either; the second value
    /// is the updated rejected set.
    func messages(known: [String: SaluMessage], rejected: Set<String>) async throws -> ([SaluMessage], Set<String>) {
        let listing: [Entry]
        do {
            listing = try JSONDecoder().decode([Entry].self, from: try await request("contents/salu-inbox/messages?ref=\(Self.branch)"))
        } catch SaluError.http(404, _) {
            _ = try await request("")  // a wrong repo or a token that doesn't cover it is a 404 too: say so
            return ([], rejected)  // the box has not sent anything yet
        }
        var out: [SaluMessage] = []
        var bad = rejected
        var seen = Set<String>()  // a file's id comes from its content: never list one twice
        var todo: [Entry] = []
        // like the CLI: only regular files, never symlinks, nothing over 64 KB
        for e in listing where e.name.hasSuffix(".json") && e.type == "file" && e.size <= Self.maxFileBytes {
            let id = String(e.name.dropLast(5))
            if let m = known[id] {
                if seen.insert(m.id).inserted { out.append(m) }
            } else if !bad.contains(id) {
                todo.append(e)
            }
        }
        // New files, 8 at a time: a first sync with many messages takes seconds, not a minute.
        var fetched: [(id: String, result: Fetched)] = []
        var start = 0
        while start < todo.count {
            let batch = Array(todo[start..<min(start + 8, todo.count)])
            start += batch.count
            try await withThrowingTaskGroup(of: (String, Fetched).self, returning: Void.self) { group in
                for e in batch {
                    group.addTask { (String(e.name.dropLast(5)), try await self.fetch(e)) }
                }
                for try await r in group { fetched.append((id: r.0, result: r.1)) }
            }
        }
        for f in fetched {
            switch f.result {
            case .message(let m): if seen.insert(m.id).inserted { out.append(m) }
            case .bad: bad.insert(f.id)  // not fetched again
            }
        }
        bad.formIntersection(listing.map { String($0.name.dropLast(5)) })  // forget files the box removed
        return (out.sorted { $0.id > $1.id }, bad)
    }

    /// Writes a new file on salu/inbox. GitHub answers 409 when the box pushed at the same moment:
    /// try again, the file is new either way.
    private func put(_ path: String, message: String, json: Data) async throws {
        let payload: [String: Any] = ["message": message, "content": json.base64EncodedString(), "branch": Self.branch]
        let body = try JSONSerialization.data(withJSONObject: payload)
        for attempt in 1...3 {
            do {
                _ = try await request(path, method: "PUT", body: body)
                return
            } catch SaluError.http(409, _) where attempt < 3 {
                try await Task.sleep(for: .milliseconds(700 * attempt))
            }
        }
    }

    func send(_ t: SaluTicket) async throws {
        try await put("contents/salu-inbox/tickets/\(t.id).json", message: "salu ticket \(t.id)", json: try Signing.encode(t, key: key))
    }

    func send(_ r: SaluReply) async throws {
        try await put("contents/salu-inbox/replies/\(r.id).json", message: "salu reply \(r.id)", json: try Signing.encode(r, key: key))
    }

    func send(_ a: SaluAction) async throws {
        try await put("contents/salu-inbox/actions/\(a.id).json", message: "salu \(a.action) \(a.id)", json: try Signing.encode(a, key: key))
    }

    /// Which private repos the token can see, and its classic scopes when it has any, for Settings: a
    /// fine-grained token limited to this repo sees only this one. Classic and `gh auth token` tokens
    /// carry scopes (`repo` = every repo you have).
    struct Reach: Sendable {
        var scopes: [String]?
        var privateRepos: [String]  // owner/name, as GitHub lists them
        var more: Bool              // more than one page: at least 100
    }

    func reach() async throws -> Reach {
        guard let url = URL(string: "https://api.github.com/user/repos?visibility=private&per_page=100") else { throw SaluError.badRepo }
        var r = URLRequest(url: url)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        r.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await URLSession.shared.data(for: r)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw SaluError.http((resp as? HTTPURLResponse)?.statusCode ?? 0, "")
        }
        struct Repo: Decodable { let full_name: String }
        let repos = try JSONDecoder().decode([Repo].self, from: data).map(\.full_name)
        let scopes = http.value(forHTTPHeaderField: "X-OAuth-Scopes").map {
            $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        return Reach(scopes: scopes, privateRepos: repos, more: (http.value(forHTTPHeaderField: "Link") ?? "").contains("rel=\"next\""))
    }

    /// GitHub's new fine-grained token page with the name, owner, 90 days and Contents read and write
    /// filled in (`tokenUrl` in src/sync/phone.ts). The repo itself can't be preselected by a link.
    static func tokenPage(owner: String, repo: String) -> URL? {
        var c = URLComponents(string: "https://github.com/settings/personal-access-tokens/new")
        c?.queryItems = [
            URLQueryItem(name: "name", value: String("salu phone \(repo)".prefix(40))),
            URLQueryItem(name: "description", value: "Salu iPhone app: reads and writes the salu/inbox branch of \(owner)/\(repo). Repository access: only \(repo)."),
            URLQueryItem(name: "target_name", value: owner),
            URLQueryItem(name: "expires_in", value: "90"),
            URLQueryItem(name: "contents", value: "write"),
        ]
        return c?.url
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

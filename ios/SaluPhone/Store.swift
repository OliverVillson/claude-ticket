import SwiftUI

@MainActor
final class Store: ObservableObject {
    private let defaults = UserDefaults.standard

    /// owner/name of the project's git remote (private repo). A pasted github.com URL works too.
    @Published var repo: String { didSet { defaults.set(repo, forKey: "repo") } }
    /// project name on the box
    @Published var project: String { didSet { defaults.set(project, forKey: "project") } }
    /// fine-grained GitHub token, kept in the Keychain
    @Published var token: String { didSet { Keychain.set(token, for: "github-token") } }

    @Published private(set) var read: Set<String> { didSet { defaults.set(Array(read), forKey: "readIds") } }
    /// Tickets this phone sent, newest first.
    @Published private(set) var sent: [SentTicket] { didSet { defaults.set(try? JSONEncoder().encode(sent), forKey: "sentTickets") } }

    @Published var messages: [SaluMessage] = []
    @Published var error: String?
    @Published var loading = false
    @Published var lastSync: Date?

    init() {
        let defaults = UserDefaults.standard  // self.defaults can't be read before every property is set
        repo = defaults.string(forKey: "repo") ?? ""
        project = defaults.string(forKey: "project") ?? ""

        // The POC kept the token in UserDefaults and read ids in one string: move both over.
        var t = Keychain.get("github-token") ?? ""
        if t.isEmpty, let old = defaults.string(forKey: "token"), !old.isEmpty {
            t = old
            Keychain.set(old, for: "github-token")
        }
        defaults.removeObject(forKey: "token")
        token = t

        var ids = Set(defaults.stringArray(forKey: "readIds") ?? [])
        if let old = defaults.string(forKey: "read") {
            ids.formUnion(old.split(separator: ",").map(String.init))
            defaults.removeObject(forKey: "read")
        }
        read = ids

        if let data = defaults.data(forKey: "sentTickets"), let list = try? JSONDecoder().decode([SentTicket].self, from: data) {
            sent = list
        } else {
            sent = []
        }
    }

    // MARK: derived

    private var client: GitHubClient? {
        guard let r = GitHubClient.parseRepo(repo), !token.isEmpty else { return nil }
        return GitHubClient(owner: r.owner, repo: r.repo, token: token)
    }
    private var repoKey: String { GitHubClient.parseRepo(repo).map { "\($0.owner)/\($0.repo)".lowercased() } ?? "" }

    var configured: Bool { client != nil }
    var unread: Int { messages.filter { !read.contains($0.id) }.count }
    func isRead(_ m: SaluMessage) -> Bool { read.contains(m.id) }

    var tickets: [TicketSummary] {
        Tickets.build(messages: messages, sent: sent.filter { $0.repo == repoKey })
    }
    func ticket(_ id: String) -> TicketSummary? { tickets.first { $0.id == id } }
    func ticket(for m: SaluMessage) -> TicketSummary? {
        guard let t = m.ticket else { return nil }
        return tickets.first { s in s.messages.contains { $0.id == m.id } || (s.number == t.id && s.project == m.project) }
    }

    /// The box's latest pause, while it lasts (usage window full).
    var pause: SaluMessage? {
        guard let last = messages.first(where: { $0.type == "orchestrator.paused" || $0.type == "orchestrator.resumed" }),
              last.type == "orchestrator.paused" else { return nil }
        if let until = last.untilDate, until < Date() { return nil }
        return last
    }

    // MARK: actions

    func refresh() async {
        guard let c = client else { return }  // not set up yet: the inbox shows how, not an error
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let known = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let fresh = try await c.messages(known: known)
            if fresh != messages { messages = fresh }
            lastSync = Date()
            error = nil
        } catch {
            if (error as? URLError)?.code == .cancelled { return }
            self.error = error.localizedDescription
        }
    }

    func markRead(_ m: SaluMessage) { if !read.contains(m.id) { read.insert(m.id) } }
    func toggleRead(_ m: SaluMessage) { if read.contains(m.id) { read.remove(m.id) } else { read.insert(m.id) } }
    func markAllRead() { read.formUnion(messages.map(\.id)) }

    /// Writes the ticket to salu/inbox. Returns nil when it went, else what went wrong.
    func send(name: String, query: String, queue: Bool, priority: Int) async -> String? {
        guard let c = client else { return SaluError.notConfigured.localizedDescription }
        let (id, ms) = newTicketId()
        do {
            try await c.send(SaluTicket(id: id, project: project, name: name, query: query, priority: priority, queue: queue, at: ms))
            sent.insert(SentTicket(id: id, repo: repoKey, project: project, name: name, query: query, queue: queue, priority: priority, at: ms), at: 0)
            if sent.count > 200 { sent.removeLast(sent.count - 200) }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    struct Check: Equatable {
        var ok: Bool
        var inbox: Bool
        var message: String
    }

    /// Settings' "Test connection".
    func checkConnection() async -> Check {
        guard GitHubClient.parseRepo(repo) != nil else { return Check(ok: false, inbox: false, message: SaluError.badRepo.localizedDescription) }
        guard let c = client else { return Check(ok: false, inbox: false, message: "Add a GitHub token.") }
        do {
            let inbox = try await c.check()
            return Check(ok: true, inbox: inbox, message: inbox
                ? "Connected. The box's inbox branch is there."
                : "The token works, but the repo has no salu/inbox branch yet. Run `salu remote add` on your computer.")
        } catch {
            return Check(ok: false, inbox: false, message: error.localizedDescription)
        }
    }
}

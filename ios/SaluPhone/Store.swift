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
    /// SALU_REMOTE_KEY of the computer and the box (`salu remote add --box` makes it). Required. Kept in the Keychain.
    @Published var signingKey: String {
        didSet {
            Keychain.set(signingKey.trimmed, for: "remote-key")
            if !demo { messages = [] }  // what was accepted under the old key is checked again
            rejected = []
        }
    }

    @Published private(set) var read: Set<String> { didSet { defaults.set(Array(read), forKey: "readIds") } }
    /// Tickets this phone sent, newest first.
    @Published private(set) var sent: [SentTicket] { didSet { defaults.set(try? JSONEncoder().encode(sent), forKey: "sentTickets") } }
    /// Replies this phone sent, newest first.
    @Published private(set) var replies: [SentReply] { didSet { defaults.set(try? JSONEncoder().encode(replies), forKey: "sentReplies") } }
    /// Unsent reply text per ticket, so closing the sheet loses nothing.
    @Published var replyDrafts: [String: String] { didSet { defaults.set(replyDrafts, forKey: "replyDrafts") } }

    @Published var messages: [SaluMessage] = []
    /// Sample data instead of a box (Demo.swift): nothing goes to GitHub while it is on.
    @Published var demo: Bool {
        didSet {
            defaults.set(demo, forKey: "demo")
            messages = demo ? Demo.messages().sorted { $0.id > $1.id } : []
            error = nil
            if !demo { Task { await refresh() } }
        }
    }
    /// Message ids whose signature failed: not fetched again, counted in the inbox.
    @Published private(set) var rejected: Set<String> = []
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
        if !defaults.bool(forKey: "keychainThisDeviceOnly") {
            Keychain.migrateAccessibility("github-token")
            defaults.set(true, forKey: "keychainThisDeviceOnly")
        }
        token = t
        signingKey = Keychain.get("remote-key") ?? ""

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
        if let data = defaults.data(forKey: "sentReplies"), let list = try? JSONDecoder().decode([SentReply].self, from: data) {
            replies = list
        } else {
            replies = []
        }
        replyDrafts = defaults.dictionary(forKey: "replyDrafts") as? [String: String] ?? [:]
        demo = defaults.bool(forKey: "demo")
        if demo { messages = Demo.messages().sorted { $0.id > $1.id } }
    }

    // MARK: derived

    /// Needs all three: the box ignores unsigned tickets and replies, so nothing is sent without the key.
    private var client: GitHubClient? {
        guard let r = GitHubClient.parseRepo(repo), !token.isEmpty, !Self.keyTooShort(signingKey), let key = Signing.key(signingKey) else { return nil }
        return GitHubClient(owner: r.owner, repo: r.repo, token: token, key: key)
    }
    private var repoKey: String {
        if demo { return "demo" }
        return GitHubClient.parseRepo(repo).map { "\($0.owner)/\($0.repo)".lowercased() } ?? ""
    }

    var configured: Bool { demo || client != nil }
    var unread: Int { messages.filter { !read.contains($0.id) }.count }
    func isRead(_ m: SaluMessage) -> Bool { read.contains(m.id) }

    var tickets: [TicketSummary] {
        Tickets.build(messages: messages, sent: sent.filter { $0.repo == repoKey }, replies: replies.filter { $0.repo == repoKey })
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
        if demo { lastSync = Date(); return }
        guard let c = client else { return }  // not set up yet: the inbox shows how, not an error
        guard !loading else { return }
        loading = true
        defer { loading = false }
        let keyAtStart = signingKey
        do {
            let known = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let (fresh, bad) = try await c.messages(known: known, rejected: rejected)
            guard signingKey == keyAtStart else { return }  // checked under a key that has since changed
            if fresh != messages { messages = fresh }
            if bad != rejected { rejected = bad }
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
        if demo {
            let (id, ms) = newTicketId()
            sent.insert(SentTicket(id: id, repo: repoKey, project: Demo.project, name: name, query: query, queue: queue, priority: priority, at: ms), at: 0)
            let number = (messages.compactMap { $0.ticket?.id }.max() ?? 15) + 1
            pretendBox(Demo.answers(number: number, name: name, ref: id, reply: false).prefix(queue ? 3 : 1))
            return nil
        }
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

    /// Writes a follow-up for the ticket to salu/inbox; the box resumes the worker's conversation with it.
    /// Returns nil when it went, else what went wrong.
    func reply(to t: TicketSummary, body: String, now: Bool) async -> String? {
        if demo {
            let (id, ms) = newTicketId()
            replies.insert(SentReply(id: id, repo: repoKey, ticket: t.id, body: body, now: now, at: ms, after: t.messages.first?.id), at: 0)
            let ref = t.id.hasPrefix("box:") ? nil : t.id
            pretendBox(Demo.answers(number: t.number ?? 0, name: t.name, ref: ref, reply: true)[...])
            return nil
        }
        guard let c = client else { return SaluError.notConfigured.localizedDescription }
        let (id, ms) = newTicketId()
        let ref = t.id.hasPrefix("box:") ? nil : t.id  // tickets this phone sent are keyed by their file id
        do {
            try await c.send(SaluReply(id: id, project: t.project, ref: ref, name: t.name, body: body, now: now, at: ms))
            replies.insert(SentReply(id: id, repo: repoKey, ticket: t.id, body: body, now: now, at: ms, after: t.messages.first?.id), at: 0)
            if replies.count > 500 { replies.removeLast(replies.count - 500) }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Sample data: the pretend box answers after a few seconds, like a real one would on its next syncs.
    private func pretendBox(_ steps: ArraySlice<(seconds: Double, make: () -> SaluMessage)>) {
        for step in steps {
            Task {
                try? await Task.sleep(for: .seconds(step.seconds))
                guard demo else { return }
                messages.insert(step.make(), at: 0)
            }
        }
    }

    /// The box refuses keys under 16 characters (`salu remote add --key`); the ones it makes are 64 hex.
    static func keyTooShort(_ key: String) -> Bool { !key.trimmed.isEmpty && key.trimmed.count < 16 }

    struct Check: Equatable {
        var ok: Bool
        var inbox: Bool
        var message: String
    }

    /// Settings' "Test connection".
    func checkConnection() async -> Check {
        guard GitHubClient.parseRepo(repo) != nil else { return Check(ok: false, inbox: false, message: SaluError.badRepo.localizedDescription) }
        guard !token.isEmpty else { return Check(ok: false, inbox: false, message: "Add a GitHub token.") }
        guard let c = client else {
            return Check(ok: false, inbox: false, message: signingKey.trimmed.isEmpty
                ? "Add the signing key: run `salu remote key` on the box and paste what it prints."
                : "That signing key is too short. Copy the whole line `salu remote key` prints.")
        }
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

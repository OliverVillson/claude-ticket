import SwiftUI

@MainActor
final class Store: ObservableObject {
    @AppStorage("repo") var repo = ""          // owner/name of the project's git remote (private repo)
    @AppStorage("project") var project = ""    // project name on the box
    @AppStorage("token") var token = ""        // POC only: move to the Keychain before sharing
    @AppStorage("read") private var readRaw = ""

    @Published var messages: [SaluMessage] = []
    @Published var error: String?
    @Published var loading = false

    var read: Set<String> {
        get { Set(readRaw.split(separator: ",").map(String.init)) }
        set { readRaw = newValue.sorted().joined(separator: ",") }
    }
    var unread: Int { messages.filter { !read.contains($0.id) }.count }

    private var client: GitHubClient? {
        let p = repo.split(separator: "/").map(String.init)
        guard p.count == 2, !token.isEmpty else { return nil }
        return GitHubClient(owner: p[0], repo: p[1], token: token)
    }

    func refresh() async {
        guard let c = client else { error = SaluError.notConfigured.localizedDescription; return }
        loading = true; defer { loading = false }
        do {
            let known = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
            messages = try await c.messages(known: known)
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    func markRead(_ m: SaluMessage) { read.insert(m.id); objectWillChange.send() }
    func markAllRead() { read.formUnion(messages.map(\.id)); objectWillChange.send() }

    func send(name: String, query: String, queue: Bool) async -> Bool {
        guard let c = client else { error = SaluError.notConfigured.localizedDescription; return false }
        let (id, ms) = newTicketId()
        do {
            try await c.send(SaluTicket(id: id, project: project, name: name, query: query, queue: queue, at: ms))
            error = nil
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
}

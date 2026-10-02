import SwiftUI

private func color(_ level: String) -> Color {
    switch level { case "success": .green; case "warn": .orange; case "error": .red; default: .secondary }
}

struct InboxView: View {
    @EnvironmentObject var store: Store
    var body: some View {
        NavigationStack {
            List(store.messages) { m in
                NavigationLink {
                    MessageDetail(m: m).onAppear { store.markRead(m) }
                } label: {
                    HStack(alignment: .top) {
                        Circle().fill(store.read.contains(m.id) ? .clear : .accentColor).frame(width: 8, height: 8).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.title).font(.headline).foregroundStyle(color(m.level))
                            Text("\(m.project) · \(m.date.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .overlay { if store.messages.isEmpty && !store.loading { ContentUnavailableView("No messages", systemImage: "tray", description: Text(store.error ?? "The orchestrator has not sent anything yet.")) } }
            .navigationTitle("Inbox")
            .toolbar { Button("Mark all read") { store.markAllRead() } }
            .refreshable { await store.refresh() }
        }
    }
}

struct MessageDetail: View {
    let m: SaluMessage
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(m.title).font(.title3.bold()).foregroundStyle(color(m.level))
                if let b = m.body { Text(b) }
                if let q = m.question { Text("Needs: \(q)").foregroundStyle(.orange) }
                if let br = m.branch { Text("Branch: \(br)").font(.footnote.monospaced()) }
                Text("\(m.type) · \(m.from)").font(.caption).foregroundStyle(.secondary)
            }.padding().frame(maxWidth: .infinity, alignment: .leading)
        }.navigationBarTitleDisplayMode(.inline)
    }
}

struct NewTicketView: View {
    @EnvironmentObject var store: Store
    @State private var name = ""
    @State private var query = ""
    @State private var queue = true
    @State private var sent = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Idea") {
                    TextField("Name", text: $name)
                    TextField("What should it do?", text: $query, axis: .vertical).lineLimit(4...12)
                }
                Toggle("Run it now", isOn: $queue)
                if let e = store.error { Text(e).foregroundStyle(.red).font(.footnote) }
                if sent { Text("Sent. It shows up on the box at its next sync.").foregroundStyle(.green).font(.footnote) }
                Button("Send ticket") {
                    Task {
                        sent = await store.send(name: name, query: query, queue: queue)
                        if sent { name = ""; query = "" }
                    }
                }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || query.isEmpty)
            }.navigationTitle("New ticket")
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var store: Store
    var body: some View {
        NavigationStack {
            Form {
                Section("Project remote (private repo)") {
                    TextField("owner/name", text: store.$repo).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Project name on the box", text: store.$project).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section("GitHub token (contents read/write on that repo)") {
                    SecureField("fine-grained token", text: store.$token)
                }
                Button("Reload inbox") { Task { await store.refresh() } }
            }.navigationTitle("Settings")
        }
    }
}

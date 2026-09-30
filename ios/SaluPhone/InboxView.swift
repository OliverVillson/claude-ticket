import SwiftUI

/// Navigation values: a message, or a ticket by id (looked up live, so it follows new messages).
struct TicketRoute: Hashable { let id: String }

extension View {
    func saluDestinations() -> some View {
        navigationDestination(for: SaluMessage.self) { MessageDetail(m: $0) }
            .navigationDestination(for: TicketRoute.self) { TicketDetail(id: $0.id) }
    }
}

enum InboxFilter: String, CaseIterable, Identifiable {
    case all, unread, needsYou
    var id: Self { self }
    var title: String {
        switch self {
        case .all: return "all"
        case .unread: return "unread"
        case .needsYou: return "needs you"
        }
    }
}

struct InboxView: View {
    @EnvironmentObject var store: Store
    var compose: () -> Void
    var openSettings: () -> Void
    @State private var filter = InboxFilter.all

    private var shown: [SaluMessage] {
        switch filter {
        case .all: return store.messages
        case .unread: return store.messages.filter { !store.isRead($0) }
        case .needsYou: return store.messages.filter(\.needsYou)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                StatusHeader().bareRow()

                if !store.configured {
                    ConnectCard(action: openSettings).bareRow()
                } else {
                    if let e = store.error {
                        Banner(glyph: "✗", text: e, color: Salu.error).bareRow()
                    }
                    if !store.rejected.isEmpty {
                        Banner(glyph: "!", text: rejectedText, color: Salu.warn).bareRow()
                    }
                    if let p = store.pause {
                        Banner(glyph: "‖", text: pauseText(p), color: Salu.paused).bareRow()
                    }
                    Picker("Show", selection: $filter) {
                        ForEach(InboxFilter.allCases) { f in Text(f.title).tag(f) }
                    }
                    .pickerStyle(.segmented)
                    .bareRow()

                    let items = shown
                    if items.isEmpty {
                        emptyState.bareRow()
                    }
                    ForEach(DayGroup.split(items)) { group in
                        Section {
                            ForEach(group.messages) { m in
                                NavigationLink(value: m) {
                                    MessageRow(m: m, unread: !store.isRead(m))
                                }
                                .saluRow()
                                .swipeActions(edge: .leading) {
                                    readButton(m)
                                }
                            }
                        } header: {
                            Text(group.title).font(Salu.mono(.caption, weight: .semibold)).foregroundStyle(Salu.chrome)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Salu.bg)
            .navigationTitle("Inbox")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Mark all read", systemImage: "checkmark.circle") { store.markAllRead() }
                            .disabled(store.unread == 0)
                        Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.refresh() } }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    if store.loading { ProgressView().tint(Salu.chrome) }
                }
            }
            .refreshable { await store.refresh() }
            .safeAreaInset(edge: .bottom) {
                if store.configured { ComposeButton(action: compose) }
            }
            .saluDestinations()
        }
    }

    private var rejectedText: String {
        let n = store.rejected.count
        return "\(n) message\(n == 1 ? "" : "s") ignored: no valid signature. Check that the signing key in Settings matches SALU_REMOTE_KEY on the box."
    }

    private func readButton(_ m: SaluMessage) -> some View {
        let isRead = store.isRead(m)
        return Button {
            store.toggleRead(m)
        } label: {
            Label(isRead ? "Unread" : "Read", systemImage: isRead ? "circle.fill" : "checkmark")
        }
        .tint(Salu.chrome)
    }

    @ViewBuilder private var emptyState: some View {
        switch filter {
        case .all:
            EmptyDog(title: "nothing yet", message: "When the box starts, finishes or gets stuck on a ticket, it shows up here.")
        case .unread:
            EmptyDog(title: "all read", message: "Nothing new from the box.")
        case .needsYou:
            EmptyDog(title: "nothing needs you", message: "No blocked or failed tickets.")
        }
    }

    private func pauseText(_ p: SaluMessage) -> String {
        guard let until = p.untilDate else { return "The box is paused: \(p.title)" }
        return "The box is paused until \(until.formatted(date: .omitted, time: .shortened)). The usage window is full."
    }
}

/// Messages under "today", "yesterday" and then one heading per date.
struct DayGroup: Identifiable {
    let id: String
    let title: String
    var messages: [SaluMessage]

    static func split(_ messages: [SaluMessage]) -> [DayGroup] {
        let cal = Calendar.current
        var groups: [DayGroup] = []
        for m in messages {
            let day = cal.startOfDay(for: m.date)
            let key = day.formatted(.iso8601.year().month().day())
            if groups.last?.id == key {
                groups[groups.count - 1].messages.append(m)
            } else {
                let title: String
                if cal.isDateInToday(day) { title = "today" }
                else if cal.isDateInYesterday(day) { title = "yesterday" }
                else { title = day.formatted(.dateTime.weekday(.wide).day().month(.wide)).lowercased() }
                groups.append(DayGroup(id: key, title: title, messages: [m]))
            }
        }
        return groups
    }
}

struct MessageRow: View {
    let m: SaluMessage
    let unread: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Capsule()
                .fill(unread ? Salu.accent : Color.clear)
                .frame(width: 3, height: 16)
                .accessibilityHidden(true)
            Text(m.look.glyph)
                .font(Salu.mono(.body, weight: .bold))
                .foregroundStyle(m.look.color)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 4) {
                Text(m.title)
                    .font(Salu.mono(.subheadline, weight: unread ? .semibold : .regular))
                    .foregroundStyle(unread ? Salu.text : Salu.dim)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(m.look.label).foregroundStyle(m.look.color.opacity(unread ? 1 : 0.7))
                    if let t = m.ticket {
                        Text("#\(t.id) \(t.name)").lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    Text(m.date, format: .relative(presentation: .named))
                }
                .font(Salu.mono(.caption2))
                .foregroundStyle(Salu.chrome)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityHint(unread ? "Unread" : "")
    }
}

struct MessageDetail: View {
    @EnvironmentObject var store: Store
    let m: SaluMessage
    @State private var replying = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 8) {
                    Chip(text: "\(m.look.glyph) \(m.look.label)", color: m.look.color)
                    Spacer()
                    Text(m.date.formatted(date: .abbreviated, time: .shortened))
                        .font(Salu.mono(.caption))
                        .foregroundStyle(Salu.chrome)
                }
                Text(m.title)
                    .font(Salu.mono(.title3, weight: .bold))
                    .foregroundStyle(Salu.text)
                    .textSelection(.enabled)

                meta

                if let q = m.question {
                    Card(title: "needs you", tint: Salu.warn) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(q).textSelection(.enabled)
                            if let t = m.ticket {
                                Text("Answer it with keep chatting. If it needs a permission, allow it on your computer and the box runs it again:")
                                    .font(Salu.mono(.caption))
                                    .foregroundStyle(Salu.dim)
                                ShellCommand(command: "salu allow \"\(t.name)\"")
                            }
                        }
                    }
                }
                if let r = m.reply, r != m.question {
                    Card(title: "reply", tint: m.look.color) {
                        Text(r).textSelection(.enabled)
                    }
                } else if let b = m.body {
                    Card(title: m.type == "ticket.failed" ? "error" : "detail", tint: m.type == "ticket.failed" ? Salu.error : Salu.chrome) {
                        Text(b).textSelection(.enabled)
                    }
                }
                if let br = m.branch {
                    Card(title: "result branch", tint: Salu.ok) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("The work is on this branch of the project's remote.")
                                .font(Salu.mono(.caption))
                                .foregroundStyle(Salu.dim)
                            ShellCommand(command: "git fetch origin \(br) && git checkout \(br)")
                        }
                    }
                }
                if let t = store.ticket(for: m) {
                    NavigationLink(value: TicketRoute(id: t.id)) {
                        HStack {
                            StateGlyph(state: t.state)
                            Text("ticket timeline").font(Salu.mono(.callout, weight: .semibold))
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote)
                        }
                        .foregroundStyle(Salu.text)
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 12).strokeBorder(Salu.stroke, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(20)
        }
        .background(Salu.bg)
        .navigationTitle(m.ticket.map { "#\($0.id)" as String } ?? "message")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { store.markRead(m) }
        .safeAreaInset(edge: .bottom) {
            if m.workerText != nil, let t = store.ticket(for: m), t.canReply, store.configured {
                ReplyButton(number: t.number) { replying = true }
            }
        }
        .sheet(isPresented: $replying) {
            if let t = store.ticket(for: m) {
                ReplySheet(ticketId: t.id).environmentObject(store)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    store.toggleRead(m)
                } label: {
                    Image(systemName: store.isRead(m) ? "circle" : "circle.fill")
                }
                .accessibilityLabel(store.isRead(m) ? "Mark unread" : "Mark read")
            }
        }
    }

    private var meta: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let t = m.ticket { row("ticket", "#\(t.id) \(t.name)") }
            row("project", m.project.isEmpty ? "?" : m.project)
            row("from", m.from)
            if let until = m.untilDate { row("resumes", until.formatted(date: .omitted, time: .shortened)) }
        }
        .font(Salu.mono(.footnote))
    }

    private func row(_ key: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(key).foregroundStyle(Salu.chrome).frame(width: 64, alignment: .leading)
            Text(value).foregroundStyle(Salu.text)
        }
    }
}

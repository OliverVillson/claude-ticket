import SwiftUI

/// Every ticket the phone knows about, as threads grouped by what they need: you, the box, or
/// nothing. Resolved ones collapse into one line each at the bottom, like resolved project threads.
struct TicketsView: View {
    @EnvironmentObject var store: Store
    var compose: () -> Void
    @AppStorage("tickets.showResolved") private var showResolved = false

    private struct Bucket: Identifiable {
        let id: String
        let tint: Color
        let states: Set<TicketState>
    }
    private let groups = [
        Bucket(id: "needs you", tint: Salu.warn, states: [.blocked, .failed]),
        Bucket(id: "working", tint: Salu.accent, states: [.running]),
        Bucket(id: "waiting", tint: Salu.chrome, states: [.sent, .queued, .backlog]),
    ]

    var body: some View {
        NavigationStack {
            let tickets = store.tickets
            List {
                if tickets.isEmpty {
                    EmptyDog(title: "no tickets yet", message: store.configured
                        ? "Write an idea as a ticket and the box runs it while you do something else."
                        : "Connect a project in Settings first.")
                        .bareRow()
                }
                ForEach(groups) { g in
                    let rows = tickets.filter { g.states.contains($0.state) }
                    if !rows.isEmpty {
                        Section {
                            ForEach(rows) { t in
                                NavigationLink(value: TicketRoute(id: t.id)) { TicketRow(t: t) }
                                    .saluRow()
                            }
                        } header: {
                            HStack {
                                Text(g.id)
                                Spacer()
                                Text("\(rows.count)")
                            }
                            .font(Salu.mono(.caption, weight: .semibold))
                            .foregroundStyle(g.tint)
                        }
                    }
                }
                let resolved = tickets.filter { $0.state == .resolved }
                if !resolved.isEmpty {
                    Section {
                        if showResolved {
                            ForEach(resolved) { t in
                                NavigationLink(value: TicketRoute(id: t.id)) { ResolvedRow(t: t) }
                                    .saluRow()
                            }
                        }
                    } header: {
                        Button {
                            withAnimation(.snappy) { showResolved.toggle() }
                        } label: {
                            HStack {
                                Text("✓ resolved")
                                Spacer()
                                Text("\(resolved.count)")
                                Image(systemName: showResolved ? "chevron.down" : "chevron.right").font(.caption2)
                            }
                            .font(Salu.mono(.caption, weight: .semibold))
                            .foregroundStyle(Salu.ok)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(showResolved ? "Hide resolved tickets" : "Show \(resolved.count) resolved tickets")
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Salu.bg)
            .navigationTitle("Tickets")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await store.refresh() }
            .safeAreaInset(edge: .bottom) {
                if store.configured { ComposeButton(action: compose) }
            }
            .saluDestinations()
        }
    }
}

struct TicketRow: View {
    let t: TicketSummary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            StateGlyph(state: t.state)
            VStack(alignment: .leading, spacing: 4) {
                Text(t.name)
                    .font(Salu.mono(.subheadline, weight: .semibold))
                    .foregroundStyle(t.state == .resolved ? Salu.dim : Salu.text)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(t.state.look.label).foregroundStyle(t.state.look.color)
                    if let n = t.number { Text("#\(n)") }
                    if let p = t.priority { Text("p\(p)").foregroundStyle(priorityColor(p)) }
                    Spacer(minLength: 6)
                    Text(t.updated, format: .relative(presentation: .named))
                }
                .font(Salu.mono(.caption2))
                .foregroundStyle(Salu.chrome)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

/// Threads this ticket's worker started, each a link to its own thread.
struct SubThreads: View {
    let items: [TicketSummary]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("sub-threads").font(Salu.mono(.caption, weight: .semibold)).foregroundStyle(Salu.chrome)
            ForEach(items) { c in
                NavigationLink(value: TicketRoute(id: c.id)) {
                    HStack(spacing: 10) {
                        Text(c.state.look.glyph).foregroundStyle(c.state.look.color)
                        Text(c.name).foregroundStyle(Salu.text).lineLimit(1)
                        Spacer(minLength: 6)
                        Text(c.state.look.label).foregroundStyle(Salu.chrome)
                        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(Salu.chrome)
                    }
                    .font(Salu.mono(.footnote))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(c.name), \(c.state.look.label)")
            }
        }
    }
}

/// A resolved ticket: one dim line, like a collapsed thread.
struct ResolvedRow: View {
    let t: TicketSummary
    var body: some View {
        HStack(spacing: 10) {
            Text("✓").foregroundStyle(Salu.ok)
            Text(t.name).foregroundStyle(Salu.dim).lineLimit(1)
            Spacer(minLength: 6)
            Text(t.updated, format: .relative(presentation: .named)).foregroundStyle(Salu.chrome)
        }
        .font(Salu.mono(.footnote))
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// One ticket as a thread: the whole conversation, what it produced, and (folded away) every step the
/// box reported. Reply to keep going or to revive a resolved one; resolve it when you're finished.
struct TicketDetail: View {
    @EnvironmentObject var store: Store
    let id: String
    @State private var replying = false
    @State private var resolving = false
    @State private var failure: String?
    @AppStorage("thread.showActivity") private var showActivity = false

    var body: some View {
        let all = store.tickets
        let t = all.first { $0.id == id }
        ScrollView {
            if let t {
                content(t, children: all.filter { $0.parent == id })
            } else {
                EmptyDog(title: "ticket gone", message: "The box no longer lists it.")
            }
        }
        .background(Salu.bg)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let t, t.canResolve, store.configured {
                    Button {
                        resolve(t)
                    } label: {
                        if resolving { ProgressView() } else { Label("Resolve", systemImage: "checkmark.circle") }
                    }
                    .disabled(resolving)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let t, t.canReply, store.configured {
                ReplyButton(number: t.number, title: t.state == .resolved ? "reply to reopen" : "keep chatting") { replying = true }
            }
        }
        .sheet(isPresented: $replying) {
            ReplySheet(ticketId: id).environmentObject(store)
        }
        .sensoryFeedback(.success, trigger: t?.state == .resolved) { old, new in !old && new }
    }

    private func resolve(_ t: TicketSummary) {
        resolving = true
        failure = nil
        Task {
            failure = await store.resolve(t)
            resolving = false
        }
    }

    private func content(_ t: TicketSummary, children: [TicketSummary]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Chip(text: "\(t.state.look.glyph) \(t.state.look.label)", color: t.state.look.color)
                if let p = t.priority { Chip(text: "p\(p)", color: priorityColor(p)) }
                Spacer()
                if let n = t.number {
                    Text("#\(n)").font(Salu.mono(.caption)).foregroundStyle(Salu.chrome)
                }
            }
            Text(t.name)
                .font(Salu.mono(.title3, weight: .bold))
                .foregroundStyle(Salu.text)
            Text(t.project.isEmpty ? "project not set" : "in \(t.project)")
                .font(Salu.mono(.footnote))
                .foregroundStyle(Salu.chrome)
            if let p = t.parent {
                NavigationLink(value: TicketRoute(id: p)) {
                    Text("↳ part of \(t.parentName ?? "another thread")")
                        .font(Salu.mono(.footnote))
                        .foregroundStyle(Salu.accent)
                }
                .buttonStyle(.plain)
            }

            if t.state == .sent, let at = t.lastSent, Date().timeIntervalSince(at) > 10 * 60 {
                Banner(glyph: "?", text: "The box hasn't picked this up yet. Is `salu remote sync --watch` running on it?", color: Salu.warn)
            }
            if t.state == .resolved {
                Banner(glyph: "✓", text: t.resolvePending
                    ? "Resolved here; the box hears about it on its next sync. Reply to reopen it."
                    : "Resolved. Reply to reopen it: the worker picks up where it left off.", color: Salu.ok)
            }
            if let failure {
                Banner(glyph: "✗", text: failure, color: Salu.error)
            }

            // what the worker is doing, asks and made
            Group {
                let checklist = t.checklist
                if !checklist.isEmpty {
                    Checklist(items: checklist)
                }
                ForEach(t.openDecisions) { d in
                    DecisionCard(ticket: t, decision: d)
                }
                let outputs = t.outputs
                if !outputs.isEmpty {
                    Outputs(items: outputs)
                }
                if !children.isEmpty {
                    SubThreads(items: children)
                }
            }

            let turns = t.conversation
            if !turns.isEmpty {
                Conversation(turns: turns)
            }

            // every step the box reported, folded away: the conversation is the thread
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.snappy) { showActivity.toggle() }
                } label: {
                    HStack {
                        Text("activity")
                        Text("\(t.messages.count + (t.sentAt == nil ? 0 : 1))").foregroundStyle(Salu.chrome.opacity(0.7))
                        Spacer()
                        Image(systemName: showActivity ? "chevron.down" : "chevron.right").font(.caption2)
                    }
                    .font(Salu.mono(.caption, weight: .semibold))
                    .foregroundStyle(Salu.chrome)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.bottom, showActivity ? 10 : 0)
                if showActivity {
                    ForEach(t.messages) { m in
                        NavigationLink(value: m) { TimelineRow(m: m, last: m.id == t.messages.last?.id && t.sentAt == nil) }
                            .buttonStyle(.plain)
                    }
                    if let at = t.sentAt {
                        TimelineStep(glyph: "▸", color: Salu.dim, title: "sent from this phone", date: at, last: true)
                    }
                }
            }
        }
        .padding(20)
        .navigationTitle(t.number.map { "#\($0)" as String } ?? "ticket")
    }
}

/// What a ticket produced, as cards on its thread: a branch to check out, a PR or link to open, a file path.
struct Outputs: View {
    let items: [TicketOutput]

    private func icon(_ kind: TicketOutput.Kind) -> String {
        switch kind {
        case .branch: return "arrow.triangle.branch"
        case .pr: return "arrow.triangle.pull"
        case .file: return "doc.text"
        case .link: return "link"
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("outputs").font(Salu.mono(.caption, weight: .semibold)).foregroundStyle(Salu.chrome)
            ForEach(items) { o in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Image(systemName: icon(o.kind))
                        Text(o.title ?? o.value).lineLimit(1).truncationMode(.middle)
                    }
                    .font(Salu.mono(.footnote, weight: .semibold))
                    .foregroundStyle(Salu.ok)
                    switch o.kind {
                    case .branch:
                        ShellCommand(command: "git fetch origin \(o.value) && git checkout \(o.value)")
                    case .pr, .link:
                        if let url = URL(string: o.value), url.scheme == "https" {
                            Link(destination: url) {
                                Text(o.value).font(Salu.mono(.caption)).lineLimit(1).truncationMode(.middle)
                            }
                            .tint(Salu.accent)
                        } else {
                            Text(o.value).font(Salu.mono(.caption)).foregroundStyle(Salu.dim)
                        }
                    case .file:
                        HStack {
                            Text(o.value).font(Salu.mono(.caption)).foregroundStyle(Salu.dim).lineLimit(2)
                            Spacer(minLength: 4)
                            CopyButton(text: o.value, label: "path")
                        }
                    }
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12).fill(Salu.surface))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Salu.ok.opacity(0.45), lineWidth: 1))
            }
        }
    }
}

/// A timeline entry linking to its message.
struct TimelineRow: View {
    let m: SaluMessage
    let last: Bool
    var body: some View {
        TimelineStep(glyph: m.look.glyph, color: m.look.color, title: m.title, date: m.date, last: last)
    }
}

/// A dot on a vertical line, a title and a time.
struct TimelineStep: View {
    let glyph: String
    let color: Color
    let title: String
    let date: Date
    let last: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(glyph)
                .font(Salu.mono(.callout, weight: .bold))
                .foregroundStyle(color)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Salu.surface))
                .overlay(Circle().strokeBorder(color.opacity(0.6), lineWidth: 1))
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(Salu.mono(.footnote, weight: .semibold))
                    .foregroundStyle(Salu.text)
                    .multilineTextAlignment(.leading)
                Text(date.formatted(date: .abbreviated, time: .shortened))
                    .font(Salu.mono(.caption2))
                    .foregroundStyle(Salu.chrome)
            }
            .padding(.bottom, last ? 0 : 18)
            Spacer(minLength: 0)
        }
        .background(alignment: .topLeading) {
            if !last {
                Rectangle().fill(Salu.stroke).frame(width: 1).padding(.top, 22).padding(.leading, 10.5)
            }
        }
        .contentShape(Rectangle())
    }
}

/// The worker's checklist while it works: ✓ done, ◐ doing, ○ to do.
struct Checklist: View {
    let items: [ChecklistItem]
    var body: some View {
        Card(title: "working on", tint: Salu.accent) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { item in
                    let m = mark(item.element.state)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(m.glyph).fontWeight(.bold).foregroundStyle(m.color)
                        Text(item.element.text).foregroundStyle(item.element.state == "done" ? Salu.dim : Salu.text)
                    }
                }
            }
        }
    }

    private func mark(_ state: String) -> (glyph: String, color: Color) {
        switch state {
        case "done": return ("✓", Salu.ok)
        case "doing": return ("◐", Salu.accent)
        default: return ("○", Salu.chrome)
        }
    }
}

/// A question the worker asked. It carries on with the recommended option; tap another to change course.
struct DecisionCard: View {
    @EnvironmentObject var store: Store
    let ticket: TicketSummary
    let decision: SaluDecision
    @State private var sending: Int?
    @State private var failure: String?

    var body: some View {
        let picked = store.pick(ticket, decision)
        Card(title: "decision", tint: Salu.warn) {
            VStack(alignment: .leading, spacing: 10) {
                Text(decision.question).font(Salu.mono(.callout, weight: .semibold))
                if let c = decision.context, !c.isEmpty {
                    Text(c).font(Salu.mono(.footnote)).foregroundStyle(Salu.dim)
                }
                ForEach(Array(decision.options.enumerated()), id: \.offset) { item in
                    option(item.offset, item.element, picked: picked)
                }
                Text(picked != nil
                     ? "Picked. Another option goes to the worker as a reply."
                     : decision.recommended == nil
                        ? "Your pick goes to the worker as a reply."
                        : "It carries on with the recommended option unless you pick another.")
                    .font(Salu.mono(.caption2))
                    .foregroundStyle(Salu.chrome)
                if let failure {
                    Text("✗ " + failure).font(Salu.mono(.caption)).foregroundStyle(Salu.error)
                }
            }
        }
    }

    private func option(_ i: Int, _ o: SaluDecision.Option, picked: Int?) -> some View {
        let recommended = i == decision.recommended
        let chosen = picked == i
        return Button {
            guard picked == nil, sending == nil else { return }
            sending = i
            failure = nil
            Task {
                failure = await store.choose(ticket, decision, option: i)
                sending = nil
            }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Text(chosen ? "●" : "○").foregroundStyle(chosen || (picked == nil && recommended) ? Salu.accent : Salu.chrome)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(o.label).font(Salu.mono(.footnote, weight: .bold)).foregroundStyle(Salu.text)
                        if recommended { Chip(text: "recommended", color: Salu.accent) }
                        if sending == i { ProgressView().controlSize(.mini) }
                    }
                    if let c = o.consequence, !c.isEmpty {
                        Text(c).font(Salu.mono(.caption)).foregroundStyle(Salu.dim).multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(chosen ? Salu.accent.opacity(0.08) : Salu.bg))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(chosen ? Salu.accent : Salu.stroke, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(picked != nil && !chosen)
        .accessibilityLabel(o.label + (recommended ? ", recommended" : ""))
    }
}

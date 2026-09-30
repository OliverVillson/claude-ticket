import SwiftUI

/// Every ticket the phone knows about, grouped by what it needs: you, the box, or nothing.
struct TicketsView: View {
    @EnvironmentObject var store: Store
    var compose: () -> Void

    private struct Bucket: Identifiable {
        let id: String
        let tint: Color
        let states: Set<TicketState>
    }
    private let groups = [
        Bucket(id: "needs you", tint: Salu.warn, states: [.blocked, .failed]),
        Bucket(id: "running", tint: Salu.accent, states: [.running]),
        Bucket(id: "waiting", tint: Salu.chrome, states: [.sent, .queued, .backlog]),
        Bucket(id: "done", tint: Salu.ok, states: [.done]),
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
                    .foregroundStyle(t.state == .done ? Salu.dim : Salu.text)
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

/// One ticket: what you asked, where it is, and everything the box said about it.
struct TicketDetail: View {
    @EnvironmentObject var store: Store
    let id: String
    @State private var replying = false

    var body: some View {
        let t = store.ticket(id)
        ScrollView {
            if let t {
                content(t)
            } else {
                EmptyDog(title: "ticket gone", message: "The box no longer lists it.")
            }
        }
        .background(Salu.bg)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if let t, t.canReply, store.configured {
                ReplyButton(number: t.number) { replying = true }
            }
        }
        .sheet(isPresented: $replying) {
            ReplySheet(ticketId: id).environmentObject(store)
        }
    }

    private func content(_ t: TicketSummary) -> some View {
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

            if t.state == .sent, let at = t.lastSent, Date().timeIntervalSince(at) > 10 * 60 {
                Banner(glyph: "?", text: "The box hasn't picked this up yet. Is `salu remote sync --watch` running on it?", color: Salu.warn)
            }

            let turns = t.conversation
            if !turns.isEmpty {
                Conversation(turns: turns)
            }

            VStack(alignment: .leading, spacing: 0) {
                Text("timeline")
                    .font(Salu.mono(.caption, weight: .semibold))
                    .foregroundStyle(Salu.chrome)
                    .padding(.bottom, 10)
                ForEach(t.messages) { m in
                    NavigationLink(value: m) { TimelineRow(m: m, last: m.id == t.messages.last?.id && t.sentAt == nil) }
                        .buttonStyle(.plain)
                }
                if let at = t.sentAt {
                    TimelineStep(glyph: "▸", color: Salu.dim, title: "sent from this phone", date: at, last: true)
                }
            }
        }
        .padding(20)
        .navigationTitle(t.number.map { "#\($0)" as String } ?? "ticket")
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

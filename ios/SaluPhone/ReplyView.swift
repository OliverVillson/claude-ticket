import SwiftUI

/// Keep chatting on a ticket: one field, sent as a `salu reply` through salu/inbox. The worker
/// resumes the same conversation, on the same branch. An unsent reply is kept per ticket.
struct ReplySheet: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let ticketId: String

    @State private var now = false
    @State private var sending = false
    @State private var sentOK = false
    @State private var failure: String?
    @FocusState private var focused: Bool

    private var draft: Binding<String> {
        Binding(get: { store.replyDrafts[ticketId] ?? "" }, set: { store.replyDrafts[ticketId] = $0.isEmpty ? nil : $0 })
    }

    var body: some View {
        NavigationStack {
            Group {
                if let t = store.ticket(ticketId) {
                    form(t)
                } else {
                    EmptyDog(title: "ticket gone", message: "The box no longer lists it.")
                }
            }
            .background(Salu.bg)
            .navigationTitle("reply")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }.foregroundStyle(Salu.chrome)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: send) {
                        if sending { ProgressView() } else { Text("Send").fontWeight(.bold) }
                    }
                    .disabled(!canSend)
                    .keyboardShortcut(.return, modifiers: .command)
                }
            }
        }
        .sensoryFeedback(.success, trigger: sentOK) { _, new in new }
        .sensoryFeedback(.error, trigger: failure) { _, new in new != nil }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var canSend: Bool {
        guard let t = store.ticket(ticketId) else { return false }
        return t.canReply && !draft.wrappedValue.trimmed.isEmpty && !sending && store.configured
    }

    private func form(_ t: TicketSummary) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 8) {
                    StateGlyph(state: t.state)
                    Text(t.name).font(Salu.mono(.subheadline, weight: .semibold)).foregroundStyle(Salu.text).lineLimit(2)
                    Spacer()
                    if let n = t.number { Text("#\(n)").font(Salu.mono(.caption)).foregroundStyle(Salu.chrome) }
                }

                if let last = t.conversation.last(where: { $0.who == .worker }) {
                    Card(title: "answering", tint: Salu.chrome) {
                        Text(last.text).lineLimit(6).foregroundStyle(Salu.dim)
                    }
                }

                // the prompt box, as in the TUI's command line
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("❯").font(Salu.mono(.title3, weight: .heavy)).foregroundStyle(Salu.accent)
                    TextField("", text: draft, prompt: Text("keep chatting…").foregroundStyle(Salu.chrome), axis: .vertical)
                        .font(Salu.mono(.body))
                        .foregroundStyle(Salu.text)
                        .lineLimit(3...12)
                        .focused($focused)
                }
                .padding(16)
                .background(RoundedRectangle(cornerRadius: 14).fill(Salu.surface))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .strokeBorder(focused ? Salu.accent : Salu.stroke, style: StrokeStyle(lineWidth: 1, dash: [5, 3]))
                )
                .onTapGesture { focused = true }

                Toggle(isOn: $now) {
                    Text("jump the queue").font(Salu.mono(.callout)).foregroundStyle(Salu.text)
                }
                .tint(Salu.accent)

                Text(hint(t))
                    .font(Salu.mono(.caption))
                    .foregroundStyle(Salu.chrome)

                if let failure {
                    Banner(glyph: "✗", text: failure, color: Salu.error)
                }
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { focused = true }
    }

    private func hint(_ t: TicketSummary) -> String {
        switch t.state {
        case .running, .queued, .sent:
            return "It isn't finished yet, so this becomes its next turn when the current run ends."
        case .blocked:
            return "Your reply answers its question. A refused permission still needs `salu allow` on your computer."
        default:
            return "The worker picks up where it left off, on the same salu/ branch."
        }
    }

    private func send() {
        guard canSend, let t = store.ticket(ticketId) else { return }
        sending = true
        failure = nil
        focused = false
        let text = draft.wrappedValue.trimmed
        Task {
            let problem = await store.reply(to: t, body: text, now: now)
            sending = false
            if let problem {
                failure = problem
            } else {
                sentOK = true
                dismiss()
            }
        }
    }
}

/// A ticket's conversation as chat bubbles: yours on the right, the worker's on the left.
struct Conversation: View {
    let turns: [Turn]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("conversation")
                .font(Salu.mono(.caption, weight: .semibold))
                .foregroundStyle(Salu.chrome)
            ForEach(turns) { TurnBubble(turn: $0) }
        }
    }
}

struct TurnBubble: View {
    let turn: Turn

    private var mine: Bool { turn.who == .you }
    private var look: Look {
        if mine { return Look(glyph: "❯", color: Salu.accent, label: turn.pending ? "you · waiting for the box" : "you") }
        switch turn.type {
        case "ticket.blocked": return Look(glyph: "?", color: Salu.warn, label: "salu · needs you")
        case "ticket.failed": return Look(glyph: "✗", color: Salu.error, label: "salu · failed")
        case "note": return Look(glyph: "!", color: Salu.warn, label: "box")
        default: return Look(glyph: "✓", color: Salu.ok, label: "salu")
        }
    }

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 36) }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(look.glyph).fontWeight(.bold)
                    Text(look.label)
                    Spacer(minLength: 8)
                    Text(turn.date, format: .relative(presentation: .named))
                }
                .font(Salu.mono(.caption2, weight: .semibold))
                .foregroundStyle(look.color)
                Text(turn.text)
                    .font(Salu.mono(.callout))
                    .foregroundStyle(turn.pending ? Salu.dim : Salu.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).fill(mine ? Salu.accent.opacity(0.08) : Salu.surface))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(look.color.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: turn.pending ? [4, 3] : []))
            )
            if !mine { Spacer(minLength: 36) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// "keep chatting" at the bottom of a finished ticket or its message.
struct ReplyButton: View {
    var number: Int?
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text("❯").fontWeight(.heavy)
                Text("keep chatting")
                Spacer()
                if let number { Text("#\(number)").fontWeight(.regular) }
                Image(systemName: "arrowshape.turn.up.left")
            }
            .font(Salu.mono(.body, weight: .bold))
            .foregroundStyle(Salu.accent)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .background(RoundedRectangle(cornerRadius: 14).fill(Salu.bg))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Salu.accent, lineWidth: 1.5))
            .shadow(color: Salu.accent.opacity(0.25), radius: 10)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityLabel("Reply to this ticket")
    }
}

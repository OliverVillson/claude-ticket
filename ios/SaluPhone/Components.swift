import SwiftUI
import UIKit

/// `▌salu › project`, as in the TUI header.
struct Wordmark: View {
    var project: String
    var body: some View {
        HStack(spacing: 6) {
            Rectangle().fill(Salu.accent).frame(width: 5, height: 20)
            Text("salu").foregroundStyle(Salu.accent).fontWeight(.bold)
            if !project.isEmpty {
                Text("›").foregroundStyle(Salu.chrome)
                Text(project).foregroundStyle(Salu.text).lineLimit(1)
            }
        }
        .font(Salu.mono(.title3))
        .accessibilityElement(children: .combine)
    }
}

/// The dog, the wordmark and one line on what the box is doing.
struct StatusHeader: View {
    @EnvironmentObject var store: Store

    var body: some View {
        let tickets = store.tickets
        let running = tickets.filter { $0.state == .running }.count
        HStack(alignment: .bottom, spacing: 14) {
            DogView(mood: running > 0 ? .running : .sleeping, pixel: 3)
            VStack(alignment: .leading, spacing: 6) {
                Wordmark(project: store.project)
                summary(tickets)
                    .font(Salu.mono(.caption))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder private func summary(_ tickets: [TicketSummary]) -> some View {
        if let p = store.pause {
            if let until = p.untilDate {
                Text("‖ paused until \(until.formatted(date: .omitted, time: .shortened))").foregroundStyle(Salu.paused)
            } else {
                Text("‖ paused").foregroundStyle(Salu.paused)
            }
        } else {
            let order: [TicketState] = [.running, .blocked, .queued, .sent, .failed, .done]
            let parts: [(text: String, color: Color)] = order.compactMap { state -> (text: String, color: Color)? in
                let n = tickets.filter { $0.state == state }.count
                return n == 0 ? nil : (text: "\(n) \(state.look.label)", color: state.look.color)
            }
            if parts.isEmpty {
                Text(store.configured ? "all quiet" : "not connected").foregroundStyle(Salu.chrome)
            } else {
                HStack(spacing: 0) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { item in
                        if item.offset > 0 { Text(" · ").foregroundStyle(Salu.chrome) }
                        Text(item.element.text).foregroundStyle(item.element.color)
                    }
                }
            }
        }
    }
}

/// A ticket's status glyph; the running one spins like the TUI's thinking spinner.
struct StateGlyph: View {
    var state: TicketState
    var body: some View {
        Group {
            if state == .running { Spinner() } else { Text(state.look.glyph) }
        }
        .font(Salu.mono(.body, weight: .bold))
        .foregroundStyle(state.look.color)
        .frame(width: 20)
        .accessibilityLabel(state.look.label)
    }
}

struct Spinner: View {
    static let frames = ["·", "✢", "✶", "✻", "✽", "✻", "✶", "✢"]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        if reduceMotion {
            Text("●")
        } else {
            TimelineView(.periodic(from: .now, by: 0.12)) { context in
                Text(Self.frames[Int(context.date.timeIntervalSinceReferenceDate / 0.12) % Self.frames.count])
            }
        }
    }
}

/// A small label in a capsule: states, priorities, meta.
struct Chip: View {
    var text: String
    var color: Color = Salu.chrome
    var filled = false
    var body: some View {
        Text(text)
            .font(Salu.mono(.caption2, weight: .semibold))
            .foregroundStyle(filled ? Color.black : color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(filled ? color : color.opacity(0.12)))
            .overlay(Capsule().strokeBorder(color.opacity(filled ? 0 : 0.5), lineWidth: 1))
    }
}

/// A titled box, like the TUI's panes: `╭─ title ──`.
struct Card<Content: View>: View {
    var title: String
    var tint: Color = Salu.chrome
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.lowercased())
                .font(Salu.mono(.caption, weight: .semibold))
                .foregroundStyle(tint)
            content
                .font(Salu.mono(.callout))
                .foregroundStyle(Salu.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12).fill(Salu.surface))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(tint.opacity(0.55), lineWidth: 1))
    }
}

/// Copies text and says so for a moment.
struct CopyButton: View {
    var text: String
    var label = "copy"
    @State private var copied = false
    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            Label(copied ? "copied" : label, systemImage: copied ? "checkmark" : "doc.on.doc")
                .font(Salu.mono(.caption, weight: .semibold))
        }
        .buttonStyle(.bordered)
        .tint(copied ? Salu.ok : Salu.chrome)
        .sensoryFeedback(.success, trigger: copied) { _, new in new }
    }
}

/// A command to run on your computer, with a copy button.
struct ShellCommand: View {
    var command: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("❯").foregroundStyle(Salu.accent)
            Text(command).foregroundStyle(Salu.text).textSelection(.enabled)
            Spacer(minLength: 4)
            CopyButton(text: command)
        }
        .font(Salu.mono(.footnote))
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Salu.bg))
    }
}

/// The big "new ticket" button at the bottom of the lists: the one thing you come to do.
struct ComposeButton: View {
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text("❯").fontWeight(.heavy)
                Text("new ticket")
                Spacer()
                Image(systemName: "plus")
            }
            .font(Salu.mono(.body, weight: .bold))
            .foregroundStyle(Color.black)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .background(RoundedRectangle(cornerRadius: 14).fill(Salu.accent))
            .shadow(color: Salu.accent.opacity(0.35), radius: 12)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityLabel("New ticket")
    }
}

/// Sleeping dog with a line under it, for empty lists.
struct EmptyDog: View {
    var title: String
    var message: String
    var body: some View {
        VStack(spacing: 14) {
            DogView(mood: .sleeping, pixel: 4)
            Text(title).font(Salu.mono(.headline)).foregroundStyle(Salu.text)
            Text(message).font(Salu.mono(.footnote)).foregroundStyle(Salu.chrome).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }
}

/// First run: what salu needs before it can show anything.
struct ConnectCard: View {
    var action: () -> Void
    var body: some View {
        Card(title: "connect a project", tint: Salu.accent) {
            VStack(alignment: .leading, spacing: 10) {
                Text("salu on your phone reads and writes the salu/inbox branch of your project's private git remote. The box on the other end runs the tickets.")
                VStack(alignment: .leading, spacing: 4) {
                    Text("1  the repo, as owner/name")
                    Text("2  the project name on the box")
                    Text("3  a fine-grained GitHub token")
                    Text("4  the signing key the box showed")
                }
                .foregroundStyle(Salu.dim)
                Button(action: action) {
                    Text("Open settings").font(Salu.mono(.callout, weight: .bold)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Salu.accent)
                .foregroundStyle(Color.black)
            }
        }
    }
}

/// A one-line strip for errors and the paused box.
struct Banner: View {
    var glyph: String
    var text: String
    var color: Color
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(glyph).fontWeight(.bold)
            Text(text).frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(Salu.mono(.footnote))
        .foregroundStyle(color)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(color.opacity(0.5), lineWidth: 1))
    }
}

extension View {
    /// List rows on the salu background with dim separators.
    func saluRow() -> some View {
        listRowBackground(Salu.bg).listRowSeparatorTint(Salu.stroke)
    }

    /// A row that is only a layout block (header, card): no background, no separator.
    func bareRow() -> some View {
        listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

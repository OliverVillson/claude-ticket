import SwiftUI

/// Idea to ticket in one step: type what it should do, send. The name comes from the first words
/// unless you give one; "run now" is on, like `salu add`. An unsent draft survives closing the sheet.
struct ComposeView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss

    @AppStorage("draft.query") private var query = ""
    @AppStorage("draft.name") private var name = ""
    @AppStorage("draft.runNow") private var runNow = true
    @AppStorage("draft.priority") private var priority = 3

    @State private var sending = false
    @State private var sent = false
    @State private var failure: String?
    @FocusState private var focus: Field?

    private enum Field { case query, name }

    private var derivedName: String { Tickets.name(from: query) }
    private var finalName: String { name.trimmed.isEmpty ? derivedName : name.trimmed }
    private var canSend: Bool { !query.trimmed.isEmpty && !finalName.isEmpty && !sending && store.configured }

    var body: some View {
        NavigationStack {
            Group {
                if sent { sentView } else { form }
            }
            .background(Salu.bg)
            .navigationTitle("new ticket")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }.foregroundStyle(Salu.chrome)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if !sent {
                        Button(action: send) {
                            if sending { ProgressView() } else { Text("Send").fontWeight(.bold) }
                        }
                        .disabled(!canSend)
                        .keyboardShortcut(.return, modifiers: .command)
                    }
                }
            }
        }
        .sensoryFeedback(.success, trigger: sent) { _, new in new }
        .sensoryFeedback(.error, trigger: failure) { _, new in new != nil }
        .presentationDragIndicator(.visible)
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // the prompt box, as in the TUI's command line
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("❯").font(Salu.mono(.title3, weight: .heavy)).foregroundStyle(Salu.accent)
                    TextField("", text: $query, prompt: Text("what should it do?").foregroundStyle(Salu.chrome), axis: .vertical)
                        .font(Salu.mono(.body))
                        .foregroundStyle(Salu.text)
                        .lineLimit(6...16)
                        .focused($focus, equals: .query)
                }
                .padding(16)
                .background(RoundedRectangle(cornerRadius: 14).fill(Salu.surface))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .strokeBorder(focus == .query ? Salu.accent : Salu.stroke, style: StrokeStyle(lineWidth: 1, dash: [5, 3]))
                )
                .onTapGesture { focus = .query }

                field("name") {
                    TextField("", text: $name, prompt: Text(derivedName.isEmpty ? "from the first words" : derivedName).foregroundStyle(Salu.chrome))
                        .font(Salu.mono(.callout))
                        .foregroundStyle(Salu.text)
                        .textInputAutocapitalization(.never)
                        .focused($focus, equals: .name)
                        .submitLabel(.done)
                }

                field("when") {
                    Picker("When", selection: $runNow) {
                        Text("run now").tag(true)
                        Text("backlog").tag(false)
                    }
                    .pickerStyle(.segmented)
                }

                field("priority") {
                    HStack(spacing: 8) {
                        ForEach(1...5, id: \.self) { p in
                            Button {
                                priority = p
                            } label: {
                                Chip(text: "p\(p)", color: priorityColor(p), filled: priority == p)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Priority \(p)")
                            .accessibilityAddTraits(priority == p ? .isSelected : [])
                        }
                        Spacer()
                    }
                }

                Text(destination)
                    .font(Salu.mono(.caption))
                    .foregroundStyle(Salu.chrome)

                if let failure {
                    Banner(glyph: "✗", text: failure, color: Salu.error)
                }
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { if query.isEmpty { focus = .query } }
    }

    private var destination: String {
        let project = store.project.isEmpty ? "the box" : store.project
        let repo = store.repo.trimmed.isEmpty ? "" : " via \(store.repo.trimmed)"
        return "goes to \(project)\(repo) on its next sync"
    }

    private func field<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(Salu.mono(.caption, weight: .semibold)).foregroundStyle(Salu.chrome)
            content()
        }
    }

    private var sentView: some View {
        VStack(spacing: 18) {
            Spacer()
            DogView(mood: .running, pixel: 5)
            Text("sent").font(Salu.mono(.title2, weight: .bold)).foregroundStyle(Salu.accent)
            Text("The box picks it up at its next sync.\nIt shows up under Tickets meanwhile.")
                .font(Salu.mono(.footnote))
                .foregroundStyle(Salu.dim)
                .multilineTextAlignment(.center)
            Spacer()
            Button {
                sent = false
                Task { focus = .query }  // after the form is back on screen
            } label: {
                Text("Write another").font(Salu.mono(.callout, weight: .semibold))
            }
            .buttonStyle(.bordered)
            .tint(Salu.chrome)
            Button {
                dismiss()
            } label: {
                Text("Done").font(Salu.mono(.callout, weight: .bold)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Salu.accent)
            .foregroundStyle(Color.black)
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
        .frame(maxWidth: .infinity)
    }

    private func send() {
        guard canSend else { return }
        sending = true
        failure = nil
        focus = nil
        let name = finalName
        let text = query.trimmed
        Task {
            let problem = await store.send(name: name, query: text, queue: runNow, priority: priority)
            sending = false
            if let problem {
                failure = problem
            } else {
                query = ""
                self.name = ""
                sent = true
            }
        }
    }
}

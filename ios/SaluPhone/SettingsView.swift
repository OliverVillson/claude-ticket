import SwiftUI
import UIKit

struct SettingsView: View {
    @EnvironmentObject var store: Store
    @State private var check: Store.Check?
    @State private var checking = false
    @State private var showToken = false
    @State private var keyDraft = ""  // saved on return or when leaving, not on every keystroke

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("", text: $store.repo, prompt: Text("owner/name").foregroundStyle(Salu.chrome))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("", text: $store.project, prompt: Text("project name on the box").foregroundStyle(Salu.chrome))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    label("project")
                } footer: {
                    note("The private git remote the box syncs with, as owner/name. A pasted github.com link works too.")
                }
                .listRowBackground(Salu.surface)

                Section {
                    HStack {
                        Group {
                            if showToken {
                                TextField("", text: $store.token, prompt: Text("github_pat_…").foregroundStyle(Salu.chrome))
                            } else {
                                SecureField("", text: $store.token, prompt: Text("github_pat_…").foregroundStyle(Salu.chrome))
                            }
                        }
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        Button {
                            showToken.toggle()
                        } label: {
                            Image(systemName: showToken ? "eye.slash" : "eye")
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Salu.chrome)
                        .accessibilityLabel(showToken ? "Hide token" : "Show token")
                    }
                    Button("Paste token") {
                        if let s = UIPasteboard.general.string { store.token = s.trimmed }
                    }
                } header: {
                    label("github token")
                } footer: {
                    note("A fine-grained token with Contents read and write on this repo only. It stays in the iOS Keychain.")
                }
                .listRowBackground(Salu.surface)

                Section {
                    SecureField("", text: $keyDraft, prompt: Text("salu remote key, on your Mac").foregroundStyle(Salu.chrome))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(saveKey)
                    Button(store.signingKey.isEmpty ? "Paste key" : "Replace with pasted key") {
                        if let s = UIPasteboard.general.string {
                            keyDraft = s.trimmed
                            saveKey()
                        }
                    }
                    if !store.signingKey.isEmpty {
                        if Store.keyTooShort(store.signingKey) {
                            Text("✗ too short: copy the whole line `salu remote key` prints")
                                .font(Salu.mono(.footnote))
                                .foregroundStyle(Salu.error)
                        } else {
                            LabeledContent("key set") {
                                Text(verbatim: "…" + String(store.signingKey.trimmed.suffix(4))).foregroundStyle(Salu.chrome)
                            }
                        }
                    }
                } header: {
                    label("signing key")
                } footer: {
                    note("Run `salu remote key | pbcopy` on your Mac (or `salu remote key` on the box) and paste it here. The phone signs every ticket and reply with it and ignores messages that aren't signed with it. After `salu remote key --new`, paste the new key here; messages signed with the old one are hidden. It stays in the iOS Keychain, on this phone only.")
                }
                .listRowBackground(Salu.surface)

                Section {
                    Button {
                        saveKey()  // a key typed without pressing return
                        Task {
                            checking = true
                            check = await store.checkConnection()
                            checking = false
                            if check?.ok == true { await store.refresh() }
                        }
                    } label: {
                        HStack {
                            Text("Test connection")
                            Spacer()
                            if checking { ProgressView() }
                        }
                    }
                    .disabled(checking)
                    if let check {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(check.ok ? (check.inbox ? "✓" : "?") : "✗").fontWeight(.bold)
                            Text(check.message)
                        }
                        .font(Salu.mono(.footnote))
                        .foregroundStyle(check.ok ? (check.inbox ? Salu.ok : Salu.warn) : Salu.error)
                    }
                    if let last = store.lastSync {
                        LabeledContent("last sync") {
                            Text(last, format: .relative(presentation: .named))
                        }
                    }
                } footer: {
                    note("The app checks the inbox every 5 seconds while it waits on the box, else every 30 seconds while it is open. Pull down on a list to check now.")
                }
                .listRowBackground(Salu.surface)

                Section {
                    Toggle("Sample data", isOn: $store.demo)
                } footer: {
                    note("Shows made-up tickets and a pretend box that answers what you send, so you can look around without one. Nothing goes to GitHub while it is on.")
                }
                .listRowBackground(Salu.surface)

                Section {
                    HStack(alignment: .bottom) {
                        DogView(mood: .sleeping, pixel: 3)
                        Spacer()
                        VStack(alignment: .trailing, spacing: 4) {
                            Wordmark(project: "")
                            Text("v\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0")")
                                .foregroundStyle(Salu.chrome)
                        }
                    }
                    .padding(.vertical, 6)
                } footer: {
                    note("Tap the dog.")
                }
                .listRowBackground(Salu.surface)
            }
            .font(Salu.mono(.callout))
            .foregroundStyle(Salu.text)
            .tint(Salu.accent)
            .scrollContentBackground(.hidden)
            .background(Salu.bg)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: store.repo) { check = nil }
            .onChange(of: store.token) { check = nil }
            .onChange(of: store.signingKey) { check = nil }
            .onAppear { keyDraft = store.signingKey }
            .onDisappear(perform: saveKey)
        }
    }

    private func saveKey() {
        if keyDraft.trimmed != store.signingKey.trimmed { store.signingKey = keyDraft.trimmed }
    }

    private func label(_ s: String) -> some View {
        Text(s).font(Salu.mono(.caption, weight: .semibold)).foregroundStyle(Salu.chrome)
    }

    private func note(_ s: String) -> some View {
        Text(s).font(Salu.mono(.caption2)).foregroundStyle(Salu.chrome)
    }
}

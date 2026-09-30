import SwiftUI

@main
struct SaluPhoneApp: App {
    @StateObject private var store = Store()

    init() {
        Salu.styleBars()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .tint(Salu.accent)
        }
    }
}

/// Inbox for what the box said, Tickets for where each ticket is, Settings for the connection.
/// "new ticket" sits at the bottom of both lists.
struct RootView: View {
    @EnvironmentObject var store: Store
    @Environment(\.scenePhase) private var phase
    @State private var tab = Screen.inbox
    @State private var composing = false

    enum Screen: Hashable { case inbox, tickets, settings }

    var body: some View {
        TabView(selection: $tab) {
            InboxView(compose: { composing = true }, openSettings: { tab = .settings })
                .tabItem { Label("Inbox", systemImage: "tray") }
                .badge(store.unread)
                .tag(Screen.inbox)
            TicketsView(compose: { composing = true })
                .tabItem { Label("Tickets", systemImage: "list.bullet.rectangle") }
                .badge(store.tickets.filter { $0.state == .blocked }.count)
                .tag(Screen.tickets)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Screen.settings)
        }
        .sheet(isPresented: $composing) {
            ComposeView().environmentObject(store)
        }
        .task(id: phase) {
            // Check the inbox while the app is on screen: at once, then every 30 seconds.
            guard phase == .active else { return }
            while !Task.isCancelled {
                await store.refresh()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }
}

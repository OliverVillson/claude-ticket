import SwiftUI

@main
struct SaluPhoneApp: App {
    @StateObject private var store = Store()
    var body: some Scene {
        WindowGroup {
            TabView {
                InboxView().tabItem { Label("Inbox", systemImage: "tray") }
                    .badge(store.unread)
                NewTicketView().tabItem { Label("New ticket", systemImage: "square.and.pencil") }
                SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }
            }
            .environmentObject(store)
            .task { await store.refresh() }
        }
    }
}

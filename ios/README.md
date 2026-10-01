# Salu phone app (POC)

SwiftUI iPhone app. It reads orchestrator messages from, and writes tickets to, the `salu/inbox` branch of a project's
git remote through the GitHub API (format: `src/sync/format.ts`, PR #51). No server.

## Open it in Xcode (Mac)
```
brew install xcodegen
cd ios && xcodegen generate && open SaluPhone.xcodeproj
```
Pick a simulator (or your iPhone + your team under Signing) and Run. In Settings enter `owner/name` of the project's
private remote, the project name, and a fine-grained GitHub token with Contents read/write on that repo.

No Xcode-generator? File > New > Project > iOS App (SwiftUI, name SaluPhone), delete the template Swift files, drag in `SaluPhone/*.swift`.

## POC limits
Token is stored in UserDefaults (use the Keychain before sharing). Refresh is manual (pull down / on launch); no push
notifications yet. Written on Linux: not compiled here, so expect a small first-build fix or two.

## Notifications (ntfy, for now)
The app itself does not receive pushes yet. Until Apple push is added, the box publishes each new orchestrator message to a
private [ntfy](https://ntfy.sh) topic and you get the notification from the free ntfy iPhone app:
1. Install **ntfy** from the App Store.
2. Tap **+** and subscribe to the topic salu prints when you set up notifications on the box (pick a long random name: anyone who knows it can read it).
3. Tapping a notification shows the title; open Salu and pull to refresh for the full message.

The box side (salu publishing to ntfy) is a separate change and is not in this PR.

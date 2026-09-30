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

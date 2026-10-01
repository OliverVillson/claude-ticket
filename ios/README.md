# Salu phone app (POC)

SwiftUI iPhone app. It reads orchestrator messages from, and writes tickets to, the `salu/inbox` branch of a project's
git remote through the GitHub API (format: `src/sync/format.ts`, PR #51). No server.

## Open it in Xcode (Mac)
```
brew install xcodegen
cd ios && xcodegen generate && open SaluPhone.xcodeproj
```
Pick a simulator (or your iPhone + your team under Signing) and Run. In Settings enter `owner/name` of the project's
private remote, the project name, a fine-grained GitHub token with Contents read/write on that repo, and the signing
key `salu remote key` prints on the box.

No Xcode-generator? File > New > Project > iOS App (SwiftUI, name SaluPhone), delete the template Swift files, drag in `SaluPhone/*.swift`.

After pulling new Swift files, run `xcodegen generate` again so Xcode sees them.

No box yet? Tap **Look around with sample data** on the first screen (or Settings > Sample data): made-up tickets in
every state and a pretend box that answers what you send. Nothing goes to GitHub while it is on.

## Screens
- **Inbox**: what the box said, newest first, by day. A green bar marks unread (swipe right to toggle); filter all /
  unread / needs you. The header dog runs while a ticket runs and sleeps otherwise (tap it: it barks).
- **Message**: blocked tickets show what they need and the `salu allow` command to copy; done ones their result branch.
- **Tickets**: every ticket as a thread, grouped by needs you / working / waiting, built from the messages plus the
  tickets this phone sent (they show as "sent" until the box answers). Finished tickets are **resolved** and collapse
  into one line each at the bottom (tap "resolved" to show them). A ticket opens as a thread: its outputs (result
  branch, with the command to check it out), the conversation (what you asked, the worker's replies, your follow-ups)
  and, folded away, every step the box reported. **Resolve** (top right) resolves it from the phone, written to
  `salu-inbox/resolves/<id>.json`; replying to a resolved ticket reopens it.
- **Keep chatting** (bottom of a ticket, or of its done / blocked / failed message): one field, sent as a `ticket-reply`
  to `salu-inbox/replies/<id>.json`, the phone's `salu reply`. The worker resumes the same session on the same branch.
  "Jump the queue" is `--now`. The ticket shows as "sent" until the box answers; the draft is kept per ticket.
- **New ticket** (the green button at the bottom): type what it should do; the name comes from the first words unless
  you give one. Run now or backlog, priority p1 to p5. The draft is kept if you close the sheet.
- **Settings**: repo (owner/name or a pasted github.com link), project, token, signing key, and Test connection.
  The signing key is required: it is the box's key, which `salu remote key` prints (`salu remote add --box` makes it; `--new` rotates it, then paste the new one). The phone signs
  every ticket and reply (`sig`, HMAC-SHA256 of the canonical JSON, `Signing.swift` = `signFile` in format.ts),
  sends nothing without it, and ignores messages without a valid signature. Like the CLI it skips inbox files over 64 KB and anything that isn't a file.

Look: `Theme.swift` holds the palette from `src/ui/theme.ts` and the TUI glyphs; `Dog.swift` draws the TUI's dog
sprites (`src/tui/dog/sprites.ts`).

## POC limits
The token is in the Keychain. The inbox is checked every 30 s while the app is open and on pull-down; no push
notifications yet. Messages are listed with the contents API, which stops at 1,000 files per folder. Written on Linux: not compiled here, so expect a small first-build fix or two.

## Notifications (ntfy, for now)
The app itself does not receive pushes yet. Until Apple push is added, the box publishes each new orchestrator message to a
private [ntfy](https://ntfy.sh) topic and you get the notification from the free ntfy iPhone app:
1. Install **ntfy** from the App Store.
2. Tap **+** and subscribe to the topic salu prints when you set up notifications on the box (pick a long random name: anyone who knows it can read it).
3. Tapping a notification shows the title; open Salu and pull to refresh for the full message.

The box side (salu publishing to ntfy) is a separate change and is not in this PR.

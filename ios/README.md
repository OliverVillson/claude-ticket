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

## Screens
- **Inbox**: what the box said, newest first, by day. A green bar marks unread (swipe right to toggle); filter all /
  unread / needs you. The header dog runs while a ticket runs and sleeps otherwise (tap it: it barks).
- **Message**: blocked tickets show what they need and the `salu allow` command to copy; done ones their result branch.
- **Tickets**: every ticket grouped by needs you / running / waiting / done, built from the messages plus the tickets
  this phone sent (they show as "sent" until the box answers). A ticket opens its conversation (what you asked, the
  worker's replies, your follow-ups) and its timeline.
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

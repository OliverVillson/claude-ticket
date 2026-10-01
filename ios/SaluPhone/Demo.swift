import Foundation

/// Sample data for looking around without a box: a few tickets in every state, made-up messages,
/// and a pretend box that answers what you send. Nothing goes to GitHub while it is on.
enum Demo {
    static let project = "web"

    /// One message, `minutesAgo` before now.
    static func message(_ minutesAgo: Double, _ type: String, _ level: String, _ title: String,
                        ticket: TicketRef? = nil, body: String? = nil, branch: String? = nil,
                        question: String? = nil, until: Double? = nil, reply: String? = nil) -> SaluMessage {
        message(at: Date().addingTimeInterval(-minutesAgo * 60), type, level, title, ticket: ticket, body: body,
                branch: branch, question: question, until: until, reply: reply)
    }

    static func message(at date: Date, _ type: String, _ level: String, _ title: String,
                        ticket: TicketRef? = nil, body: String? = nil, branch: String? = nil,
                        question: String? = nil, until: Double? = nil, reply: String? = nil) -> SaluMessage {
        let ms = (date.timeIntervalSince1970 * 1000).rounded()
        let hex = (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        return SaluMessage(v: 1, id: String(format: "%013lld", Int64(ms)) + "-" + hex, project: project, from: "salu-box",
                           at: ms, type: type, level: level, title: title, body: body, branch: branch,
                           question: question, ticket: ticket, until: until, reply: reply)
    }

    private static func t(_ id: Int, _ name: String) -> TicketRef { TicketRef(ref: nil, name: name, id: id) }

    /// The inbox as it looks after a day of use. Oldest first.
    static func messages() -> [SaluMessage] {
        let login = t(14, "fix login redirect")
        var working = message(2, "ticket.status", "info", "fix login redirect: checklist updated", ticket: login)
        working.checklist = Lenient([
            ChecklistItem(text: "reproduce the loop after SSO", state: "done"),
            ChecklistItem(text: "keep `next` through the callback", state: "done"),
            ChecklistItem(text: "run the full test suite", state: "doing"),
            ChecklistItem(text: "open a PR", state: "todo"),
        ])
        var asked = message(3, "ticket.decision", "info", "fix login redirect asks: Keep the old /auth/return route working?", ticket: login)
        asked.decision = Lenient(SaluDecision(
            id: "1", question: "Keep the old /auth/return route working?",
            options: [.init(label: "Redirect it", consequence: "Old links keep working; one extra route to maintain."),
                      .init(label: "Remove it", consequence: "Less code; old links land on a 404.")],
            recommended: 0))
        let gridDone = message(62, "ticket.done", "success", "fix css grid is done: 3 files changed, tests pass", ticket: t(11, "fix css grid"),
                               body: "3 files changed, tests pass.", branch: "salu/fix-css-grid",
                               reply: "Done on salu/fix-css-grid. The pricing grid now uses minmax(200px, 1fr) with three columns down to 700px, then two. I added a Playwright test at 768px and 700px. 3 files changed, tests pass.")
        var gridOutputs = message(63, "ticket.output", "info", "fix css grid made PR #71 and 1 file", ticket: t(11, "fix css grid"))
        gridOutputs.outputs = Lenient([
            SaluOutput(kind: "pr", ref: "https://github.com/acme/web/pull/71", title: "PR #71 fix css grid"),
            SaluOutput(kind: "file", ref: "tests/pricing-grid.spec.ts", title: nil),
        ])
        let dark = t(10, "dark mode toggle")
        let grid = t(11, "fix css grid")
        let clone = t(12, "clone api repo")
        let deps = t(15, "bump dependencies")
        return [
            message(26 * 60, "ticket.accepted", "info", "Accepted as #10", ticket: dark),
            message(25 * 60, "ticket.started", "info", "Started dark mode toggle", ticket: dark),
            message(24 * 60, "ticket.done", "success", "dark mode toggle is done", ticket: dark,
                    body: "Toggle in the header, saved per browser.", branch: "salu/dark-mode-toggle",
                    reply: "Added a toggle to the header that switches the theme and remembers it in localStorage. It follows the system setting until you pick one. 4 files changed, tests pass. The work is on salu/dark-mode-toggle."),
            message(20 * 60, "orchestrator.paused", "warn", "Paused: the usage window is full",
                    body: "Tickets wait until it resets.", until: (Date().addingTimeInterval(-18 * 3600).timeIntervalSince1970 * 1000).rounded()),
            message(18 * 60, "orchestrator.resumed", "info", "Resumed: the usage window reset"),
            message(125, "ticket.accepted", "info", "Accepted as #11", ticket: grid),
            message(121, "ticket.started", "info", "Started fix css grid", ticket: grid),
            gridOutputs,
            gridDone,
            message(30, "ticket.accepted", "info", "Accepted as #15", ticket: deps),
            message(14, "ticket.accepted", "info", "Accepted as #14", ticket: login),
            message(9, "ticket.started", "info", "Started fix login redirect", ticket: login),
            asked,
            working,
            message(6, "ticket.accepted", "info", "Accepted as #12", ticket: clone),
            message(5, "ticket.started", "info", "Started clone api repo", ticket: clone),
            message(4, "ticket.blocked", "warn", "clone api repo needs permission: Bash(git clone *)", ticket: clone,
                    body: "The worker tried to clone git@github.com:acme/api.git into the project folder.",
                    question: "needs permission: Bash(git clone *)",
                    reply: "I need to clone git@github.com:acme/api.git to read its OpenAPI spec, but `git clone` isn't allowed for this ticket. Allow it with `salu allow \"clone api repo\"`, or reply with where I can find the spec instead."),
        ]
    }

    /// What the pretend box says, and after how many seconds, when you send a ticket or a reply.
    static func answers(number: Int, name: String, ref: String?, reply: Bool) -> [(seconds: Double, make: () -> SaluMessage)] {
        let ticket = TicketRef(ref: ref, name: name, id: number)
        return [
            (2, { message(at: Date(), "ticket.accepted", "info", reply ? "Got your reply on \"\(name)\", queued to run" : "Accepted as #\(number)", ticket: ticket) }),
            (5, { message(at: Date(), "ticket.started", "info", "Started \(name)", ticket: ticket) }),
            (12, { message(at: Date(), "ticket.done", "success", "\(name) is done", ticket: ticket,
                           body: "Sample answer.", branch: "salu/" + name.replacingOccurrences(of: " ", with: "-"),
                           reply: reply
                               ? "(Sample data) Picked up where I left off and did what you asked, on the same branch. A real box would answer here with the worker's reply."
                               : "(Sample data) This is where the worker's reply shows up when a real box runs the ticket.") }),
        ]
    }
}

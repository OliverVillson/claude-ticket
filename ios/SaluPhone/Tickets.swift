import Foundation

/// Where a ticket is, as far as the phone can tell from the messages the box sent back.
enum TicketState: String, Codable, CaseIterable {
    case sent      // written to salu/inbox by this phone, the box has not answered yet
    case queued    // the box accepted it and will run it
    case backlog   // the box accepted it into the backlog (sent with "run now" off)
    case running   // "working"
    case blocked   // needs you: a permission, an answer
    case failed
    case resolved  // finished, or resolved by you; collapses out of the way. A reply revives it.
}

/// A ticket this phone sent. Kept on the phone so it shows up before the box has seen it.
struct SentTicket: Codable, Identifiable, Hashable {
    var id: String       // the ticket file's id; the box echoes it back as `ticket.ref`
    var repo: String
    var project: String
    var name: String
    var query: String
    var queue: Bool
    var priority: Int
    var at: Double

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

/// A reply this phone sent on a ticket, kept so the conversation shows it before the box answers.
struct SentReply: Codable, Identifiable, Hashable {
    var id: String       // the reply file's id
    var repo: String
    var ticket: String   // TicketSummary.id it belongs to
    var body: String
    var now: Bool
    var at: Double
    var after: String? = nil  // newest message id the phone had for the ticket when it sent this

    /// The box answers every reply: "Got your reply" (ticket.accepted) or a warning note.
    func answered(by messages: [SaluMessage]) -> Bool {
        messages.contains { m in
            (m.type == "ticket.accepted" || (m.type == "note" && m.level == "warn")) && m.id > (after ?? "")
        }
    }

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

/// A ticket this phone resolved. It shows as resolved at once; anything the box reports afterwards
/// (a reply reviving it, a new run) wins.
struct SentResolve: Codable, Identifiable, Hashable {
    var id: String       // the resolve file's id
    var repo: String
    var ticket: String   // TicketSummary.id
    var at: Double
    var after: String?   // newest message id the phone had for the ticket when it sent this

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

/// Something a ticket produced, shown as a card on its thread. Today only the result branch; the
/// worker's PRs and files join it when the box sends them.
struct TicketOutput: Identifiable, Hashable {
    enum Kind { case branch }
    let kind: Kind
    let value: String
    var id: String { value }
}

/// One line of a ticket's conversation: what you asked or answered, and what the worker said back.
struct Turn: Identifiable, Hashable {
    enum Who { case you, worker }
    let id: String
    let who: Who
    let text: String
    let date: Date
    var type: String? = nil  // the worker's message type: done, blocked or failed
    var pending = false      // yours, and the box has not picked it up yet
}

/// One ticket, put together from what this phone sent and every message the box sent about it.
struct TicketSummary: Identifiable, Hashable {
    let id: String             // the ticket file id when known, else "box:<project>#<number>"
    var name: String
    var project: String
    var number: Int?           // the ticket's number on the box
    var state: TicketState
    var updated: Date
    var sentAt: Date?
    var query: String?         // only for tickets sent from this phone
    var priority: Int?
    var messages: [SaluMessage] = []  // newest first
    var replies: [SentReply] = []     // oldest first
    var lastSent: Date?        // the phone's latest write for it (the ticket or a reply) still waiting on the box
    var resolvePending = false // resolved from this phone, the box hasn't confirmed yet

    /// The box queues a follow-up on any ticket it knows, except one in the backlog (`salu reply` refuses those).
    /// On a resolved ticket the reply revives it.
    var canReply: Bool { number != nil && state != .backlog }
    /// Resolve anything the box knows that isn't working right now or already resolved.
    var canResolve: Bool { number != nil && ![.resolved, .running, .sent].contains(state) }

    /// Result branches and the like, newest first, each once.
    var outputs: [TicketOutput] {
        var seen = Set<String>()
        return messages.compactMap { m in
            guard let b = m.branch, seen.insert(b).inserted else { return nil }
            return TicketOutput(kind: .branch, value: b)
        }
    }

    /// What you said and what the worker said, oldest first.
    var conversation: [Turn] {
        var turns: [Turn] = []
        if let q = query, let at = sentAt { turns.append(Turn(id: "query", who: .you, text: q, date: at)) }
        for r in replies {
            turns.append(Turn(id: r.id, who: .you, text: r.body, date: r.date, pending: !r.answered(by: messages)))
        }
        for m in messages {
            if let text = m.workerText { turns.append(Turn(id: m.id, who: .worker, text: text, date: m.date, type: m.type)) }
        }
        return turns.sorted { $0.date < $1.date }
    }
}

enum Tickets {
    /// The state a message moves its ticket to; nil for messages that do not change it.
    static func state(after type: String) -> TicketState? {
        switch type {
        case "ticket.accepted", "ticket.reopened": return .queued
        case "ticket.started": return .running
        case "ticket.done", "ticket.resolved": return .resolved
        case "ticket.blocked": return .blocked
        case "ticket.failed": return .failed
        default: return nil
        }
    }

    /// Tickets newest activity first. Messages may come in any order.
    static func build(messages: [SaluMessage], sent: [SentTicket], replies: [SentReply] = [], resolves: [SentResolve] = []) -> [TicketSummary] {
        var byKey: [String: TicketSummary] = [:]
        var alias: [String: String] = [:]  // "box:<project>#<n>" -> ticket file id
        var queueOf: [String: Bool] = [:]

        for s in sent {
            byKey[s.id] = TicketSummary(id: s.id, name: s.name, project: s.project, number: nil, state: .sent,
                                        updated: s.date, sentAt: s.date, query: s.query, priority: s.priority, lastSent: s.date)
            queueOf[s.id] = s.queue
        }

        for m in messages.sorted(by: { $0.id < $1.id }) {  // ids sort by time
            guard let t = m.ticket else { continue }
            let boxKey = "box:\(m.project)#\(t.id)"
            let key: String
            if let ref = t.ref {
                key = ref
                alias[boxKey] = ref
            } else {
                key = alias[boxKey] ?? boxKey
            }
            var s = byKey[key] ?? TicketSummary(id: key, name: t.name, project: m.project, number: t.id, state: .queued, updated: m.date)
            s.name = t.name
            s.number = t.id
            if !m.project.isEmpty { s.project = m.project }
            if var next = state(after: m.type) {
                if next == .queued && s.state == .sent && queueOf[key] == false { next = .backlog }
                if next == .queued && s.state == .running { next = .running }  // a reply during a run: it stays running, the reply is its next turn
                s.state = next
            }
            s.updated = max(s.updated, m.date)
            s.lastSent = nil  // the box answered
            s.messages.insert(m, at: 0)
            byKey[key] = s
        }

        // What this phone did to tickets the box knows, oldest first: replies and resolves.
        enum Action { case reply(SentReply), resolve(SentResolve) }
        let actions: [(at: Double, action: Action)] =
            replies.map { (at: $0.at, action: Action.reply($0)) } + resolves.map { (at: $0.at, action: Action.resolve($0)) }
        for (_, action) in actions.sorted(by: { $0.at < $1.at }) {
            switch action {
            case .reply(let r):
                // A reply the box hasn't answered yet puts the ticket back to "sent" (a running one keeps running).
                guard var s = byKey[r.ticket] else { continue }
                s.replies.append(r)
                if !r.answered(by: s.messages) {
                    if s.state != .running { s.state = .sent }
                    s.lastSent = r.date
                    s.updated = max(s.updated, r.date)
                }
                byKey[r.ticket] = s
            case .resolve(let r):
                // Resolved at once, unless the box has reported something else about the ticket since.
                guard var s = byKey[r.ticket] else { continue }
                let since = s.messages.filter { $0.id > (r.after ?? "") }
                let confirmed = since.contains { $0.type == "ticket.resolved" }
                let movedOn = since.contains { m in
                    guard let next = state(after: m.type) else { return false }
                    return next != .resolved  // a reply's ack or a new run: the ticket is alive again
                }
                if !movedOn {
                    s.state = .resolved
                    s.resolvePending = !confirmed
                    s.lastSent = nil
                }
                byKey[r.ticket] = s
            }
        }
        return byKey.values.sorted { $0.updated > $1.updated }
    }

    /// A ticket name from what the ticket should do: its first few words, the way you would type
    /// `salu add "fix login redirect"`.
    static func name(from query: String, words: Int = 5, maxLength: Int = 48) -> String {
        let firstLine = query.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let picked = firstLine.split(whereSeparator: \.isWhitespace).prefix(words).joined(separator: " ")
        var name = String(picked.lowercased().prefix(maxLength))
        while let last = name.last, last.isPunctuation || last.isWhitespace { name.removeLast() }
        return name
    }
}

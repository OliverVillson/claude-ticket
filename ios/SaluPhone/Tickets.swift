import Foundation

/// Where a ticket is, as far as the phone can tell from the messages the box sent back.
enum TicketState: String, Codable, CaseIterable {
    case sent      // written to salu/inbox by this phone, the box has not answered yet
    case queued    // the box accepted it and will run it
    case backlog   // the box accepted it into the backlog (sent with "run now" off)
    case running
    case blocked   // needs you: a permission, an answer
    case failed
    case done
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
}

enum Tickets {
    /// The state a message moves its ticket to; nil for messages that do not change it.
    static func state(after type: String) -> TicketState? {
        switch type {
        case "ticket.accepted": return .queued
        case "ticket.started": return .running
        case "ticket.done": return .done
        case "ticket.blocked": return .blocked
        case "ticket.failed": return .failed
        default: return nil
        }
    }

    /// Tickets newest activity first. Messages may come in any order.
    static func build(messages: [SaluMessage], sent: [SentTicket]) -> [TicketSummary] {
        var byKey: [String: TicketSummary] = [:]
        var alias: [String: String] = [:]  // "box:<project>#<n>" -> ticket file id
        var queueOf: [String: Bool] = [:]

        for s in sent {
            byKey[s.id] = TicketSummary(id: s.id, name: s.name, project: s.project, number: nil, state: .sent,
                                        updated: s.date, sentAt: s.date, query: s.query, priority: s.priority)
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
                if next == .queued && queueOf[key] == false { next = .backlog }
                s.state = next
            }
            s.updated = max(s.updated, m.date)
            s.messages.insert(m, at: 0)
            byKey[key] = s
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

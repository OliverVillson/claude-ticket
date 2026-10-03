import Foundation

/// Mirrors src/sync/format.ts (format version 1): messages come from the box, tickets go to it.
struct SaluMessage: Codable, Identifiable, Hashable {
    var v: Int
    var id: String
    var project: String
    var from: String
    var at: Double
    var type: String
    var level: String
    var title: String
    var body: String?
    var branch: String?
    var question: String?
    var ticket: TicketRef?
    var until: Double?  // orchestrator.paused: epoch ms it resumes
    var reply: String?  // ticket.done / ticket.blocked: the worker's whole final message (body is its one-line summary)
    // Thread extras (MessageFile in format.ts). They decode leniently: a shape the phone doesn't know
    // is skipped, not fatal for the whole message.
    var state: String?                        // ticket.state: the ticket's new state in the core's words (done, todo, ...)
    var checklist: Lenient<[ChecklistItem]>?  // ticket.status: the worker's whole checklist, replacing the last one
    var decision: Lenient<SaluDecision>?      // ticket.decision: a question with options
    var outputs: Lenient<[SaluOutput]>?       // ticket.output: branches, PRs, files, links it made
    var by: String?                           // ticket.accepted: who added the ticket (team projects)
    var seat: Lenient<SaluSeat>?              // ticket.started: the Claude seat running it, with how much of its window is left
    var parent: TicketRef?                    // ticket.spawned: `ticket` is a sub-thread this ticket's worker started

    /// What the worker said, as fully as the box sent it.
    var workerText: String? {
        switch type {
        case "ticket.done": return reply ?? body
        case "ticket.blocked": return reply ?? question ?? body
        case "ticket.failed": return reply ?? body
        case "note" where ticket != nil && level == "warn": return title  // e.g. a reply the box refused
        default: return nil
        }
    }

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
    var untilDate: Date? { until.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// Plain values only: safe to hand between tasks (GitHubClient fetches several at once).
extension SaluMessage: @unchecked Sendable {}

/// One line of a working ticket's checklist. `state`: todo, doing or done.
struct ChecklistItem: Codable, Hashable {
    var text: String
    var state: String
}

/// A question the worker asked with options; it carries on with the recommended one meanwhile.
/// Answer it with a reply carrying `decision` (SaluReply.Answer).
struct SaluDecision: Codable, Hashable, Identifiable {
    struct Option: Codable, Hashable {
        var label: String
        var consequence: String?
    }
    var id: String  // the box's decision id
    var question: String
    var context: String?
    var options: [Option]
    var recommended: Int?  // index into options; nil when the worker didn't pick one

    init(id: String, question: String, context: String? = nil, options: [Option], recommended: Int?) {
        self.id = id
        self.question = question
        self.context = context
        self.options = options
        self.recommended = recommended
    }

    private enum CodingKeys: String, CodingKey { case id, question, context, options, recommended }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) {
            id = s
        } else {
            id = String(try c.decode(Int.self, forKey: .id))  // the database's number, if a box sends it bare
        }
        question = try c.decode(String.self, forKey: .question)
        context = try? c.decodeIfPresent(String.self, forKey: .context)
        options = try c.decode([Option].self, forKey: .options)
        let r = try? c.decodeIfPresent(Int.self, forKey: .recommended)
        recommended = r.flatMap { options.indices.contains($0) ? $0 : nil }
    }
}

/// Something the worker attached to its thread. `kind`: branch, pr, file or link.
/// The Claude seat a ticket runs on (MessageFile.seat in format.ts). `owner` differs from the author on a borrowed seat.
struct SaluSeat: Codable, Hashable {
    var label: String
    var owner: String?
    var left: Int?  // percent of the seat's 5-hour window still free
}

struct SaluOutput: Codable, Hashable {
    var kind: String
    var ref: String
    var title: String?
}

/// Decodes to nil instead of failing the whole message when the shape is unexpected.
struct Lenient<T: Codable & Hashable>: Codable, Hashable {
    var value: T?
    init(_ value: T?) { self.value = value }
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

/// The box's ticket a message is about. `ref` is the id of the ticket file when it came from a client (this phone).
struct TicketRef: Codable, Hashable {
    var ref: String?
    var name: String
    var id: Int
}

struct SaluTicket: Codable {
    var v = 1
    var id: String
    var project: String
    var name: String
    var query: String
    var tags: [String: String] = [:]
    var labels: [String] = []
    var priority = 3
    var queue = true
    var at: Double
}

/// A follow-up on a ticket the box already has (`salu reply` from the phone), ReplyFile in format.ts: the
/// worker resumes the same conversation with `body`. Written once to salu-inbox/replies/<id>.json.
/// The box finds the ticket by `ref` (the ticket file id, for tickets this phone sent), else by `name`,
/// and always answers with a message: "Got your reply on …" or a warning.
struct SaluReply: Codable {
    var v = 1
    var id: String
    var project: String
    var ref: String?
    var name: String?
    var ticket: Target?  // the same ticket again, with its number on the box (flat ref/name is for older boxes)
    var body: String
    var now = false  // jump the queue, like `salu reply --now`
    var decision: Answer?  // this reply answers one of the worker's decisions
    var at: Double

    /// `salu reply --pick`: the decision's id and the chosen option (0-based).
    struct Answer: Codable {
        var id: String
        var option: Int?
    }
}

/// Which ticket a reply or action is about: `ref` (the ticket file id, preferred), else `id` (its number
/// on the box), else `name`.
struct Target: Codable {
    var ref: String?
    var id: Int?
    var name: String?
}

/// Resolve or reopen a ticket from the phone (`salu resolve` / `salu reopen`), ActionFile in format.ts.
/// Written once to salu-inbox/actions/<id>.json; the box answers with a `ticket.state` message, or a
/// warning when its salu can't resolve tickets yet.
struct SaluAction: Codable {
    var v = 1
    var id: String
    var project: String
    var ticket: Target
    var action: String  // resolve or reopen
    var at: Double
}

/// `<13-digit epoch ms>-<8 hex>`, same as newId() in format.ts.
func newTicketId() -> (id: String, ms: Double) {
    let ms = (Date().timeIntervalSince1970 * 1000).rounded()
    let hex = (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    return (String(format: "%013lld", Int64(ms)) + "-" + hex, ms)  // %d is 32-bit: epoch ms needs lld
}

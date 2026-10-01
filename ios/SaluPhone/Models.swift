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
    // Thread extras from the worker's `salu` tool (worker-tool.md). The inbox format for them is not
    // final, so they decode leniently: a shape the phone doesn't know yet is skipped, not fatal.
    var checklist: Lenient<[ChecklistItem]>?  // the ticket's whole checklist while it works
    var decisions: Lenient<[SaluDecision]>?   // the ticket's decisions
    var outputs: Lenient<[SaluOutput]>?       // branches, PRs, files, links it attached

    /// What the worker said, as fully as the box sent it.
    var workerText: String? {
        switch type {
        case "ticket.done", "ticket.resolved": return reply ?? body
        case "ticket.blocked": return reply ?? question ?? body
        case "ticket.failed": return reply ?? body
        case "note" where ticket != nil && level == "warn": return title  // e.g. a reply the box refused
        default: return nil
        }
    }

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
    var untilDate: Date? { until.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// One line of a working ticket's checklist. `state`: todo, doing or done.
struct ChecklistItem: Codable, Hashable {
    var text: String
    var state: String
}

/// A question the worker asked with options; it carries on with the recommended one meanwhile.
struct SaluDecision: Codable, Hashable, Identifiable {
    struct Option: Codable, Hashable {
        var label: String
        var consequence: String?
    }
    var id: Int
    var question: String
    var context: String?
    var options: [Option]
    var recommended: Int
    var status: String?  // open or answered
    var chosen: Int?
}

/// Something the worker attached to its thread. `kind`: branch, pr, file or link.
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
    var body: String
    var now = false  // jump the queue, like `salu reply --now`
    var at: Double
}

/// Resolve a ticket from the phone (`salu resolve`). Written once to salu-inbox/resolves/<id>.json; the
/// box finds the ticket like a reply (`ref`, else `name`) and answers with `ticket.resolved`.
struct SaluResolve: Codable {
    var v = 1
    var id: String
    var project: String
    var ref: String?
    var name: String?
    var at: Double
}

/// `<13-digit epoch ms>-<8 hex>`, same as newId() in format.ts.
func newTicketId() -> (id: String, ms: Double) {
    let ms = (Date().timeIntervalSince1970 * 1000).rounded()
    let hex = (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    return (String(format: "%013lld", Int64(ms)) + "-" + hex, ms)  // %d is 32-bit: epoch ms needs lld
}

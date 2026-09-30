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

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
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

/// `<13-digit epoch ms>-<8 hex>`, same as newId() in format.ts.
func newTicketId() -> (id: String, ms: Double) {
    let ms = Date().timeIntervalSince1970 * 1000
    let hex = (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    return (String(format: "%013d", Int64(ms)) + "-" + hex, ms.rounded())
}

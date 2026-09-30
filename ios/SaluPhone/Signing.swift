import CryptoKit
import Foundation

/// Optional inbox signing, the same as `signFile` / `signatureOk` in src/sync/format.ts. With a key
/// (SALU_REMOTE_KEY on the computer and the box), every file carries `sig` = hex HMAC-SHA256 of its
/// canonical JSON without `sig`: keys sorted, compact, strings and numbers as JSON.stringify writes them.
enum Signing {
    /// The key as the CLI reads it (trimmed); nil when signing is off.
    static func key(_ raw: String) -> SymmetricKey? {
        let k = raw.trimmed
        return k.isEmpty ? nil : SymmetricKey(data: Data(k.utf8))
    }

    /// JSON for a file to write: `value` encoded, plus `sig` when there is a key.
    static func encode<T: Encodable>(_ value: T, key: SymmetricKey?) throws -> Data {
        let plain = try JSONEncoder().encode(value)
        guard let key else { return plain }
        guard var object = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else { return plain }
        object["sig"] = hex(sign(canonical(object), key: key))
        return try JSONSerialization.data(withJSONObject: object)
    }

    /// Whether a file read from the remote may be used: always without a key, else only with a valid `sig`.
    static func verify(_ data: Data, key: SymmetricKey?) -> Bool {
        guard let key else { return true }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sig = object["sig"] as? String, let mac = unhex(sig), mac.count == 32 else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: Data(canonical(object).utf8), using: key)
    }

    private static func sign(_ text: String, key: SymmetricKey) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: key))
    }

    /// canonical() in format.ts.
    static func canonical(_ value: Any) -> String {
        switch value {
        case let o as [String: Any]:
            // JS sorts keys by UTF-16 code units
            let keys = o.keys.filter { $0 != "sig" }.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            return "{" + keys.map { quote($0) + ":" + canonical(o[$0]!) }.joined(separator: ",") + "}"
        case let a as [Any]:
            return "[" + a.map(canonical).joined(separator: ",") + "]"
        case let s as String:
            return quote(s)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
            return number(n.doubleValue)
        default:
            return "null"  // NSNull
        }
    }

    /// Numbers as JSON.stringify writes them. Inbox files only hold integers (ids, times, priorities).
    private static func number(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == d.rounded(), abs(d) <= 9_007_199_254_740_991 { return String(Int64(d)) }  // JS's safe integers
        return "\(d)"
    }

    /// A string as JSON.stringify quotes it: only ", \ and control characters are escaped.
    private static func quote(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        return out + "\""
    }

    private static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    private static func unhex(_ s: String) -> Data? {
        guard s.count == 64, s.allSatisfy({ $0.isHexDigit && ($0.isNumber || $0.isLowercase) }) else { return nil }
        var out = Data()
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        return out
    }
}

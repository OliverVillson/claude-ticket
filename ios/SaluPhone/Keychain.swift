import Foundation
import Security

/// The GitHub token lives in the iOS Keychain, not in UserDefaults.
enum Keychain {
    private static let service = "dev.salu.phone"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func get(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// An empty value deletes the item.
    static func set(_ value: String, for account: String) {
        SecItemDelete(query(account) as CFDictionary)
        guard !value.isEmpty else { return }
        var add = query(account)
        add[kSecValueData as String] = Data(value.utf8)
        // Readable only while the phone is unlocked, never synced to iCloud or restored onto another device.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    /// Items saved by earlier builds used AfterFirstUnlock (could move with a backup): write them again.
    static func migrateAccessibility(_ account: String) {
        if let value = get(account) { set(value, for: account) }
    }
}

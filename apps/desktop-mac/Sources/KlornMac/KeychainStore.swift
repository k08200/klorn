import Foundation
import Security
import os

/// Persists the Klorn JWT in the macOS Keychain (generic password). There is no
/// cookie session — the API authenticates with `Authorization: Bearer` — so the
/// token is the one secret we must store securely across launches.
///
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`: an interactive desktop JWT is
/// only used while the user is present, and must never sync to iCloud Keychain
/// or migrate in a backup.
///
/// An unsigned `swift run` dev binary may be denied Keychain writes
/// (errSecMissingEntitlement); in that case the token is kept in a process-only
/// in-memory fallback so dev sign-in still works for the session. A signed,
/// distributed `.app` gets real Keychain persistence.
enum KeychainStore {
    private static let memory = OSAllocatedUnfairLock<String?>(initialState: nil)

    private static func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Config.keychainService,
            kSecAttrAccount as String: account,
        ]
    }

    @discardableResult
    static func save(_ token: String, account: String = Config.keychainAccount) -> Bool {
        memory.withLock { $0 = token }
        SecItemDelete(baseQuery(account) as CFDictionary)
        var add = baseQuery(account)
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func load(account: String = Config.keychainAccount) -> String? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
           let data = item as? Data,
           let token = String(data: data, encoding: .utf8),
           !token.isEmpty {
            return token
        }
        return memory.withLock { $0 }  // unsigned-dev fallback
    }

    static func clear(account: String = Config.keychainAccount) {
        memory.withLock { $0 = nil }
        SecItemDelete(baseQuery(account) as CFDictionary)
    }
}

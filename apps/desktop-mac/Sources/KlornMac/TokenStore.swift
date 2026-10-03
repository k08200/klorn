import Foundation
import os

/// Where the session JWT lives. The running app keeps it in the Keychain; the
/// offscreen harnesses (`--render-previews`, `--self-check`) get a store that
/// never leaves the process.
///
/// An unsigned `swift run` binary that asks the Keychain for the shipped app's
/// item blocks on a macOS permission dialog, and reads the developer's real
/// token if the dialog is allowed. A harness must do neither, so the model takes
/// its store as a parameter instead of reaching for `KeychainStore` directly.
protocol TokenStore: Sendable {
    func load() -> String?
    /// False when the token could not be persisted beyond this process.
    @discardableResult func save(_ token: String) -> Bool
    func clear()
}

/// The production store: `KeychainStore`, same service and account as before
/// the seam existed.
struct KeychainTokenStore: TokenStore {
    func load() -> String? { KeychainStore.load() }
    @discardableResult func save(_ token: String) -> Bool { KeychainStore.save(token) }
    func clear() { KeychainStore.clear() }
}

/// Process-only store for the harnesses. Starts empty unless seeded.
final class InMemoryTokenStore: TokenStore {
    private let token: OSAllocatedUnfairLock<String?>

    init(token: String? = nil) {
        self.token = OSAllocatedUnfairLock(initialState: token)
    }

    func load() -> String? { token.withLock { $0 } }

    @discardableResult func save(_ token: String) -> Bool {
        self.token.withLock { $0 = token }
        return true
    }

    func clear() { token.withLock { $0 = nil } }
}

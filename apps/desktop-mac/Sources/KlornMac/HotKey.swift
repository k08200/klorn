import AppKit
import Carbon.HIToolbox

/// A single system-wide hotkey via Carbon `RegisterEventHotKey` — the standard
/// way to get a global shortcut that fires even when the app has no focus (which
/// an `.accessory` app never does). Unlike an `NSEvent` global monitor it needs
/// NO Accessibility permission and consumes the key. Default: ⌥⌘K to toggle the
/// bar from anywhere, keeping the "keyboard-completable" promise.
@MainActor
final class HotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let onFire: () -> Void

    private static let signature: OSType = 0x4B4C524E  // 'KLRN'
    private static let idValue: UInt32 = 1

    init(onFire: @escaping () -> Void) { self.onFire = onFire }

    /// Register (or re-register) the user's shortcut. Safe to call repeatedly —
    /// it tears down any prior registration first, so changing the shortcut in
    /// Preferences takes effect immediately.
    func register(_ shortcut: Shortcut) {
        register(keyCode: shortcut.keyCode, modifiers: shortcut.carbonModifiers)
    }

    /// Register the shortcut. Defaults to ⌥⌘K. Re-registers cleanly on repeat.
    func register(keyCode: UInt32 = UInt32(kVK_ANSI_K),
                  modifiers: UInt32 = UInt32(cmdKey | optionKey)) {
        unregister()  // drop any prior hotkey so a re-register doesn't stack
        var eventSpec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()

        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData -> OSStatus in
            guard let userData else { return noErr }
            // Carbon app-target hotkey handlers fire on the main thread.
            MainActor.assumeIsolated {
                Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue().onFire()
            }
            return noErr
        }, 1, &eventSpec, context, &handler)

        let hotKeyID = EventHotKeyID(signature: Self.signature, id: Self.idValue)
        let status = RegisterEventHotKey(keyCode, modifiers, hotKeyID,
                                         GetApplicationEventTarget(), 0, &ref)
        if status != noErr {
            // Combo claimed by another app / invalid: the binding is silently
            // dead otherwise — log so a "shortcut doesn't work" report is
            // diagnosable. UI-level feedback can build on this later.
            Log.app.warning("hotkey registration failed: OSStatus \(status, privacy: .public)")
        }
    }

    /// Explicit teardown. Not called from deinit: this object lives for the whole
    /// process (owned by the app delegate), so the OS reclaims the registration at
    /// exit — and a @MainActor deinit can't touch these non-Sendable Carbon refs.
    func unregister() {
        if let ref { UnregisterEventHotKey(ref); self.ref = nil }
        if let handler { RemoveEventHandler(handler); self.handler = nil }
    }
}

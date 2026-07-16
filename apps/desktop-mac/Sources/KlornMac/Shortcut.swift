import AppKit
import Carbon.HIToolbox

/// A global keyboard shortcut (key + modifiers), stored so the user can set
/// their own instead of the hardcoded ⌥⌘K. Carbon modifier bits so it feeds
/// `RegisterEventHotKey` directly. All formatting/validation is pure and pinned
/// by the self-check harness.
struct Shortcut: Codable, Equatable, Sendable {
    var keyCode: UInt32
    var carbonModifiers: UInt32

    /// The out-of-box toggle shortcut.
    static let defaultToggle = Shortcut(
        keyCode: UInt32(kVK_ANSI_K),
        carbonModifiers: UInt32(cmdKey | optionKey))
}

enum ShortcutFormat {
    /// NSEvent modifier flags → Carbon modifier bits (what RegisterEventHotKey wants).
    static func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
        var m: UInt32 = 0
        if flags.contains(.command) { m |= UInt32(cmdKey) }
        if flags.contains(.option) { m |= UInt32(optionKey) }
        if flags.contains(.control) { m |= UInt32(controlKey) }
        if flags.contains(.shift) { m |= UInt32(shiftKey) }
        return m
    }

    /// A global shortcut must carry at least one of ⌘/⌥/⌃ — shift-only (or no)
    /// modifier would swallow ordinary typing everywhere.
    static func isValid(carbonModifiers m: UInt32) -> Bool {
        (m & UInt32(cmdKey | optionKey | controlKey)) != 0
    }

    /// "⌥⌘K" — the macOS-standard glyph order is ⌃⌥⇧⌘, then the key.
    static func display(_ s: Shortcut) -> String {
        modifierSymbols(s.carbonModifiers) + keyLabel(s.keyCode)
    }

    static func modifierSymbols(_ m: UInt32) -> String {
        var out = ""
        if m & UInt32(controlKey) != 0 { out += "⌃" }
        if m & UInt32(optionKey) != 0 { out += "⌥" }
        if m & UInt32(shiftKey) != 0 { out += "⇧" }
        if m & UInt32(cmdKey) != 0 { out += "⌘" }
        return out
    }

    /// Virtual keycode → a human label. Covers the realistic shortcut keys
    /// (letters, digits, and the common named keys); anything else degrades to
    /// "Key<code>" rather than crashing.
    static func keyLabel(_ code: UInt32) -> String {
        if let named = namedKeys[Int(code)] { return named }
        return "Key\(code)"
    }

    private static let namedKeys: [Int: String] = {
        var m: [Int: String] = [
            kVK_Space: "Space", kVK_Return: "↩", kVK_Tab: "⇥", kVK_Escape: "⎋",
            kVK_Delete: "⌫", kVK_ForwardDelete: "⌦",
            kVK_LeftArrow: "←", kVK_RightArrow: "→", kVK_UpArrow: "↑", kVK_DownArrow: "↓",
            kVK_ANSI_Grave: "`", kVK_ANSI_Minus: "-", kVK_ANSI_Equal: "=",
            kVK_ANSI_LeftBracket: "[", kVK_ANSI_RightBracket: "]",
            kVK_ANSI_Semicolon: ";", kVK_ANSI_Quote: "'", kVK_ANSI_Comma: ",",
            kVK_ANSI_Period: ".", kVK_ANSI_Slash: "/", kVK_ANSI_Backslash: "\\",
        ]
        let letters: [(Int, String)] = [
            (kVK_ANSI_A, "A"), (kVK_ANSI_B, "B"), (kVK_ANSI_C, "C"), (kVK_ANSI_D, "D"),
            (kVK_ANSI_E, "E"), (kVK_ANSI_F, "F"), (kVK_ANSI_G, "G"), (kVK_ANSI_H, "H"),
            (kVK_ANSI_I, "I"), (kVK_ANSI_J, "J"), (kVK_ANSI_K, "K"), (kVK_ANSI_L, "L"),
            (kVK_ANSI_M, "M"), (kVK_ANSI_N, "N"), (kVK_ANSI_O, "O"), (kVK_ANSI_P, "P"),
            (kVK_ANSI_Q, "Q"), (kVK_ANSI_R, "R"), (kVK_ANSI_S, "S"), (kVK_ANSI_T, "T"),
            (kVK_ANSI_U, "U"), (kVK_ANSI_V, "V"), (kVK_ANSI_W, "W"), (kVK_ANSI_X, "X"),
            (kVK_ANSI_Y, "Y"), (kVK_ANSI_Z, "Z"),
        ]
        let digits: [(Int, String)] = [
            (kVK_ANSI_0, "0"), (kVK_ANSI_1, "1"), (kVK_ANSI_2, "2"), (kVK_ANSI_3, "3"),
            (kVK_ANSI_4, "4"), (kVK_ANSI_5, "5"), (kVK_ANSI_6, "6"), (kVK_ANSI_7, "7"),
            (kVK_ANSI_8, "8"), (kVK_ANSI_9, "9"),
        ]
        for (k, v) in letters + digits { m[k] = v }
        return m
    }()
}

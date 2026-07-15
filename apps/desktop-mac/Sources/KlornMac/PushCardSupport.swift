import Foundation

/// Pure PushCard logic — key mapping and the item queue — kept AppKit-free so
/// the self-check harness can assert it (the Command Line Tools toolchain has
/// no XCTest; see SelfCheck.swift).

/// What a key press does inside an ARMED card. The card only consumes keys
/// after an explicit arm (click on the card or the global hotkey): a panel
/// that grabbed the keyboard on appear would route a "1" typed in the user's
/// editor into a real email send.
enum PushCardAction: Equatable, Sendable {
    case send(Int)  // 0-based option index (key "1" → 0)
    case open       // open the item on the web inbox
    case dismiss    // hide the card locally; never touches server state
}

enum PushCardKeymap {
    private static let escKeyCode: UInt16 = 53

    /// Map a key press to a card action; nil means "not ours, let it through".
    /// `chars` is NSEvent.charactersIgnoringModifiers.
    static func action(chars: String?, keyCode: UInt16) -> PushCardAction? {
        if keyCode == escKeyCode { return .dismiss }
        switch chars {
        case "1": return .send(0)
        case "2": return .send(1)
        case "3": return .send(2)
        case "\r": return .open
        default: return nil
        }
    }
}

/// FIFO of PUSH items awaiting a card, deduped by AttentionItem id. One card
/// shows at a time ("1 of N"); a burst of PUSH enqueues behind the current one.
struct PushCardQueue: Equatable, Sendable {
    private(set) var items: [FirewallItem] = []

    var current: FirewallItem? { items.first }
    var pendingCount: Int { max(0, items.count - 1) }

    mutating func enqueue(_ new: [FirewallItem]) {
        let known = Set(items.map(\.id))
        items += new.filter { !known.contains($0.id) }
    }

    mutating func advance() {
        guard !items.isEmpty else { return }
        items.removeFirst()
    }

    mutating func clear() { items = [] }
}

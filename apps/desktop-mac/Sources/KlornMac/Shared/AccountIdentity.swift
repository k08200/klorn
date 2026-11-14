import Foundation

/// Each connected account's identity color (M1, founder decision
/// 2026-11-13): a bright hue for its dot in the sidebar and the ring around
/// a face from that account, and the seed of the window chrome's tint while
/// that account is selected. The bright hue never fills a surface; the
/// chrome uses only its desaturated tone (`Theme.chromeStops`).
///
/// Colors follow the account's stable position in the server's inbox list
/// (primary first). A per-account picker in Settings is planned (LATER, not
/// built): it replaces `color(for:among:)`'s body with "the user's pick,
/// else the palette", and every caller already goes through that one seam.
enum AccountIdentity {
    /// amber, teal, coral, then blue, lime and pink: six hues apart from
    /// each other and from purple.
    static let palette: [Theme.RGBA] = [
        Theme.hex(0xF5A524), Theme.hex(0x2DD4BF), Theme.hex(0xF87171),
        Theme.hex(0x60A5FA), Theme.hex(0xA3E635), Theme.hex(0xF472B6),
    ]

    static func color(at index: Int) -> Theme.RGBA {
        palette[((index % palette.count) + palette.count) % palette.count]
    }

    /// The one account → color seam.
    static func color(for inbox: InboxOption, among inboxes: [InboxOption]) -> Theme.RGBA? {
        inboxes.firstIndex(of: inbox).map(color(at:))
    }

    /// The color of the account a mail is on: `accountId` nil is the primary
    /// account (the wire's null), an id no inbox has gets none.
    static func color(accountId: String?, among inboxes: [InboxOption]) -> Theme.RGBA? {
        inboxes.first { $0.id == accountId }.flatMap { color(for: $0, among: inboxes) }
    }

    /// The selected scope's color: nil for "all" (the chrome is espresso).
    static func color(selection: String, among inboxes: [InboxOption]) -> Theme.RGBA? {
        guard let value = inboxQueryParam(selected: selection) else { return nil }
        return inboxes.first { $0.selectionValue == value }.flatMap { color(for: $0, among: inboxes) }
    }

    /// A mail's account color, when the row says which account it is on.
    static func color(of item: FirewallItem, among inboxes: [InboxOption]) -> Theme.RGBA? {
        guard let source = item.email?.source else { return nil }
        return color(accountId: source.accountId, among: inboxes)
    }
}

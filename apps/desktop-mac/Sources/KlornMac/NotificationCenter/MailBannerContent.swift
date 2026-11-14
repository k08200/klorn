import Foundation

/// A mail banner's words: the Mac mirror of the server's ONE formatter,
/// `mailPushContent` (packages/api/src/notify/mail-push-content.ts, decision
/// N1 + NC1). Every other channel (web push, FCM / APNs, Telegram, Windows)
/// carries that function's output, so this mirrors it rule for rule:
///   - title: the sender's display name, else the address, else the From
///     header as written — the first that is not empty once cleaned
///     (mail-push-content.ts:77-84 `senderTitle`);
///   - body: the subject (the localized stand-in when empty), then on line 2
///     the verified quote in curly quotes, else the judge's short reason
///     (mail-push-content.ts:92-113 `reasonLine` / `mailPushContent`);
///   - every field: bounded prefix, HTML tags and comments removed, format
///     characters dropped, controls to spaces, whitespace collapsed, trimmed,
///     capped with "…" (mail-push-content.ts:53-63 `plainLine`).
///
/// Lengths are UTF-16 code units, as JavaScript's `length` / `slice` count
/// them, so a cap lands on the same character on both sides. (A cap that
/// splits a surrogate pair leaves a lone surrogate in JS; Swift substitutes
/// U+FFFD there — the one place the two can differ, only past a cap.)
///
/// Mac-only: a banner with no sender at all (no From on the item, which the
/// server never has) is titled "Klorn" rather than left blank. Pure.
enum MailBannerContent {
    /// mail-push-content.ts:33-35.
    static let titleMax = 100
    static let subjectMax = 180
    static let reasonMax = 140
    /// mail-push-content.ts:37 SCAN_FACTOR: how much of a field is read at all.
    static let scanFactor = 4
    /// email-address.ts:200 MAX_FROM_REGEX_CHARS (boundedFromValue).
    static let fromMax = 1000

    static func compose(from: String?, subject: String?, reason: NotificationReason?) -> (title: String, body: String) {
        let sender = senderTitle(from ?? "")
        let title = sender.isEmpty ? "Klorn" : sender
        let line = plainLine(subject, subjectMax)
        let subjectLine = line.isEmpty ? L("banner.noSubject") : line
        let why = reasonLine(reason)
        return (title, why.isEmpty ? subjectLine : "\(subjectLine)\n\(why)")
    }

    /// mail-push-content.ts:92-101: the verified quote in curly quotes (its
    /// own edge quotation marks removed), else the short reason, else "".
    static func reasonLine(_ reason: NotificationReason?) -> String {
        guard let reason else { return "" }
        if reason.verified, let raw = reason.quote, !raw.isEmpty {
            let quote = jsTrim(stripEdgeQuotes(plainLine(raw, reasonMax - 2)))
            if !quote.isEmpty { return "“\(quote)”" }
        }
        return plainLine(reason.text, reasonMax)
    }

    /// mail-push-content.ts:77-84 + email-address.ts:183-192, 203-205.
    static func senderTitle(_ from: String) -> String {
        let header = jsTrim(utf16Prefix(from, fromMax))
        let name = plainLine(displayNameOf(header), titleMax)
        if !name.isEmpty { return name }
        let address = plainLine(MailAddressParser.parseAddress(header), titleMax)
        return address.isEmpty ? plainLine(header, titleMax) : address
    }

    /// email-address.ts:183-192 `displayNameOf`: the text before the LAST
    /// "<", trimmed, one outer quote removed each side, trimmed; nil if empty.
    static func displayNameOf(_ value: String) -> String? {
        let units = Array(value.utf16)
        guard let open = units.lastIndex(of: 0x3C), open > 0 else { return nil }
        var name = jsTrim(string(units[0..<open]))
        let quotes: Set<UInt16> = [0x22, 0x27]
        var u = Array(name.utf16)
        if let first = u.first, quotes.contains(first) { u.removeFirst() }
        if let last = u.last, quotes.contains(last) { u.removeLast() }
        name = jsTrim(string(u[...]))
        return name.isEmpty ? nil : name
    }

    // MARK: plainLine (mail-push-content.ts:53-63)

    // mail-push-content.ts:45 HTML_TAG /<(?:\/?[a-z]|[!?])[^<>]*>/gi. Written
    // with [a-zA-Z] and no case-insensitive flag: ICU's case folding would also
    // match "ſ" and the Kelvin sign, which JS's non-unicode /i does not.
    private static let htmlTag = try! NSRegularExpression(pattern: "<(?:/?[a-zA-Z]|[!?])[^<>]*>")

    static func plainLine(_ value: String?, _ max: Int) -> String {
        let bounded = utf16Prefix(value ?? "", max * scanFactor)
        let ns = bounded as NSString
        let untagged = htmlTag.stringByReplacingMatches(
            in: bounded, range: NSRange(location: 0, length: ns.length), withTemplate: " ")
        var out = String.UnicodeScalarView()
        var pendingSpace = false
        for scalar in untagged.unicodeScalars {
            let category = scalar.properties.generalCategory
            if category == .format { continue }  // \p{Cf} dropped
            if category == .control || isJSWhitespace(scalar) {  // \p{Cc} → " ", then \s+ → " "
                pendingSpace = true
                continue
            }
            if pendingSpace, !out.isEmpty { out.append(" ") }
            pendingSpace = false
            out.append(scalar)
        }
        let text = String(out)  // leading / trailing runs never emitted: trimmed
        let units = Array(text.utf16)
        guard units.count > max else { return text }
        return string(units[0..<(max - 1)]) + "…"
    }

    // MARK: JS string semantics

    /// JavaScript's \s and String.prototype.trim set (ECMA-262 WhiteSpace +
    /// LineTerminator).
    static func isJSWhitespace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            true
        default: false
        }
    }

    static func jsTrim(_ value: String) -> String {
        let scalars = value.unicodeScalars
        guard let start = scalars.firstIndex(where: { !isJSWhitespace($0) }),
              let end = scalars.lastIndex(where: { !isJSWhitespace($0) }) else { return "" }
        return String(scalars[start...end])
    }

    /// mail-push-content.ts:50 EDGE_QUOTES /^["“”'‘’「」]+|["“”'‘’「」]+$/g.
    static func stripEdgeQuotes(_ value: String) -> String {
        let marks: Set<Character> = ["\"", "“", "”", "'", "‘", "’", "「", "」"]
        var chars = Substring(value)
        while let first = chars.first, marks.contains(first) { chars.removeFirst() }
        while let last = chars.last, marks.contains(last) { chars.removeLast() }
        return String(chars)
    }

    static func utf16Prefix(_ value: String, _ count: Int) -> String {
        let units = Array(value.utf16)
        return units.count > count ? string(units[0..<count]) : value
    }

    static func string(_ units: ArraySlice<UInt16>) -> String {
        String(decoding: units, as: UTF16.self)
    }
}

/// email-address.ts:27-102 `parseAddress`, ported line for line over UTF-16
/// code units (every character it branches on is ASCII). The mailbox of a
/// From-style value, "" when it does not name exactly one. Pure.
enum MailAddressParser {
    private static let backslash: UInt16 = 0x5C, quote: UInt16 = 0x22, open: UInt16 = 0x3C
    private static let close: UInt16 = 0x3E, lparen: UInt16 = 0x28, rparen: UInt16 = 0x29, at: UInt16 = 0x40

    static func parseAddress(_ value: String) -> String {
        let units = Array(value.utf16)
        return scanMailbox(units) ?? soleAngleAddress(units)
    }

    /// email-address.ts:33-41.
    private static func soleAngleAddress(_ v: [UInt16]) -> String {
        guard let o = v.firstIndex(of: open), let c = v.firstIndex(of: close), c >= o else { return "" }
        if v[(o + 1)...].contains(open) || v[(c + 1)...].contains(close) { return "" }
        let inner = MailBannerContent.jsTrim(MailBannerContent.string(v[(o + 1)..<c]))
        return isPlainAddress(inner) ? inner : ""
    }

    /// email-address.ts:47-102.
    private static func scanMailbox(_ v: [UInt16]) -> String? {
        var outside: [String] = []
        var runStart = 0
        var mailbox: String?
        var angles = 0
        var angleStart = -1
        var quoteStart = -1
        var commentDepth = 0
        func slice(_ a: Int, _ b: Int) -> String {
            let lo = min(max(a, 0), v.count), hi = min(max(b, lo), v.count)
            return MailBannerContent.string(v[lo..<hi])
        }
        var i = 0
        while i < v.count {
            defer { i += 1 }
            let ch = v[i]
            if commentDepth > 0 {
                if ch == backslash { i += 1 } else if ch == lparen { commentDepth += 1 } else if ch == rparen {
                    commentDepth -= 1
                    if commentDepth == 0 { runStart = i + 1 }
                }
                continue
            }
            if quoteStart >= 0 {
                if ch == backslash { i += 1 } else if ch == quote {
                    if angleStart < 0 {
                        let next = i + 1 < v.count ? v[i + 1] : nil
                        outside.append(next == at ? slice(quoteStart, i + 1) : " ")
                        runStart = i + 1
                    }
                    quoteStart = -1
                }
                continue
            }
            if ch == backslash { return nil }
            if angleStart >= 0 {
                if ch == quote { quoteStart = i } else if ch == open { return "" } else if ch == close {
                    mailbox = slice(angleStart, i)
                    angleStart = -1
                    runStart = i + 1
                }
                continue
            }
            if ch != quote && ch != lparen && ch != open { continue }
            outside.append(slice(runStart, i))
            if ch == quote {
                quoteStart = i
            } else if ch == lparen {
                commentDepth = 1
                outside.append(" ")
            } else {
                angles += 1
                if angles > 1 { return "" }
                angleStart = i + 1
            }
        }
        if angleStart >= 0 { return "" }
        if quoteStart >= 0 || commentDepth > 0 { return nil }
        if let mailbox { return MailBannerContent.jsTrim(mailbox) }
        outside.append(slice(runStart, v.count))
        return MailBannerContent.jsTrim(outside.joined())
    }

    /// email-address.ts:108 PLAIN_ADDRESS
    /// /^[^\s<>"\\(),;:@\p{Cc}]+@[^\s<>"\\(),;:@\p{Cc}]+$/u.
    static func isPlainAddress(_ value: String) -> Bool {
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return false }
        return parts.allSatisfy { part in
            !part.isEmpty && part.unicodeScalars.allSatisfy { s in
                !MailBannerContent.isJSWhitespace(s) && s.properties.generalCategory != .control
                    && !"<>\"\\(),;:".unicodeScalars.contains(s)
            }
        }
    }
}

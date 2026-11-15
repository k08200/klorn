import SwiftUI

/// The small, calm "Beta" tag beside a mail source still in beta (Naver,
/// iCloud, the IMAP presets) — the web's BetaChip: a hairline-bordered raised chip in the
/// caption role, dim ink, never an accent colour or a pill.
struct BetaChip: View {
    var body: some View {
        Text(L("common.beta"))
            .font(Theme.Typo.caption.weight(.semibold))
            .foregroundStyle(Theme.textDim)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.chip))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.chip)
                    .strokeBorder(Theme.line, lineWidth: Theme.hairline))
    }
}

/// Which mail sources are still in beta. Connectable on this build: Gmail /
/// Google Calendar (Google sign-in), Naver Mail, iCloud Mail and the IMAP
/// presets — Daum, Kakao, Yahoo, AOL, Fastmail, Zoho (IMAP, beta — all but
/// Naver only while the server has them). Outlook is decoded for display if a
/// server sends it, but never offered. Pure for the harness.
enum MailSourceCatalog {
    /// Whether a mailbox's provider carries the Beta tag.
    static func isBeta(_ provider: String?) -> Bool {
        switch provider?.uppercased() {
        case "NAVER", "ICLOUD",
             "DAUM", "KAKAO", "YAHOO", "AOL", "FASTMAIL", "ZOHO", "ZOHOPRO": true
        default: false
        }
    }
}

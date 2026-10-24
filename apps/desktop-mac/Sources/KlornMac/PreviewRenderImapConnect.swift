import SwiftUI

// Settings ▸ Accounts' IMAP connect form for `--render-previews`: the section
// with both entry points, then the iCloud Mail form empty, filled, refused and
// connecting. Fixtures are obviously fake — never a real Apple ID or password.

extension PreviewRender {
    private static let fakeAppleID = "you@icloud.example"
    private static let fakeAppPassword = "abcd-efgh-ijkl-mnop"
    private static let imapShotWidth: CGFloat = 560

    static func renderImapConnect(dir: URL, dark: Bool) -> Bool {
        let model = AppModel(tokenStore: InMemoryTokenStore())
        model.seedImapForRender(accounts: [:], available: [.naver, .icloud])
        let shots: [(name: String, height: CGFloat, failure: ImapConnectFailure?, filled: Bool, connecting: Bool)] = [
            ("imap-icloud-empty", 420, nil, false, false),
            ("imap-icloud-filled", 420, nil, true, false),
            ("imap-icloud-error", 460, .appPasswordRejected, true, false),
            ("imap-icloud-connecting", 420, nil, true, true),
        ]
        var ok = writeShot(
            "imap-accounts-entry", size: CGSize(width: imapShotWidth, height: 200), align: .top,
            model: model, dir: dir, dark: dark
        ) {
            imapCard(InboxAccountsSection(model: model))
        }
        for shot in shots {
            ok = writeShot(
                shot.name, size: CGSize(width: imapShotWidth, height: shot.height), align: .top,
                model: model, dir: dir, dark: dark
            ) {
                imapCard(
                    ImapConnectForm(
                        provider: .icloud, model: model, onClose: {},
                        email: shot.filled ? fakeAppleID : "",
                        password: shot.filled ? fakeAppPassword : "",
                        failure: shot.failure, showsConnecting: shot.connecting))
            } && ok
        }
        return ok
    }

    /// The Settings panel chrome the section sits in.
    private static func imapCard(_ content: some View) -> some View {
        content
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line))
            .padding(14)
    }
}

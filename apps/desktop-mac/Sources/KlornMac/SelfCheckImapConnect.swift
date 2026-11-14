import Foundation

// Self-check for the IMAP connect form (Naver + iCloud Mail, 2026-10-24; the
// fixed-host presets Daum … Zoho, 2026-11-14): the request it sends, how each
// server refusal reads, the field rules, the password never leaving memory
// except in that one request, and the entry points. Pure and source scans
// only — no window, no network, no Keychain. Fixtures are obviously fake
// (you@icloud.example / abcd-efgh-ijkl-mnop).

@MainActor
func imapConnectSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    let fakeEmail = "you@icloud.example"
    let retiredName = "Apple" + " Mail"
    // Needles assembled so the token-store scan does not match this file.
    let storageNeedles = ["Log.", "print(", "NSLog", "UserDefaults", "@AppStorage", "Key" + "chain", "Sec" + "Item"]
    let fakePassword = "abcd-efgh-ijkl-mnop"

    // MARK: 1. providers and endpoints
    check("iCloud posts to the gated /api/icloud-imap routes",
          ImapMailProvider.icloud.connectPath == "/api/icloud-imap/connect"
              && ImapMailProvider.icloud.statusPath == "/api/icloud-imap/status"
              && ImapMailProvider.icloud.disconnectPath == "/api/icloud-imap/disconnect")
    check("naver keeps its /api/naver-imap routes",
          ImapMailProvider.naver.connectPath == "/api/naver-imap/connect"
              && ImapMailProvider.naver.statusPath == "/api/naver-imap/status")
    check("the providers carry their server enum names",
          ImapMailProvider.icloud.rawValue == "ICLOUD" && ImapMailProvider.naver.rawValue == "NAVER")
    let help = ImapMailProvider.icloud.appPasswordHelpURL
    check("iCloud's app-specific password link is https://appleid.apple.com",
          help?.scheme == "https" && help?.host == "appleid.apple.com")
    check("every provider is beta", ImapMailProvider.allCases.allSatisfy { MailSourceCatalog.isBeta($0.rawValue) })
    check("the providers keep the server's display order",
          ImapMailProvider.allCases.map(\.rawValue)
              == ["NAVER", "ICLOUD", "DAUM", "KAKAO", "YAHOO", "AOL", "FASTMAIL", "ZOHO", "ZOHOPRO"])
    // Pinned literally (not derived the way the enum derives them): the
    // server mounts /api/<slug>-imap/{status,connect,disconnect} per preset.
    let routes: [ImapMailProvider: String] = [
        .naver: "/api/naver-imap", .icloud: "/api/icloud-imap", .daum: "/api/daum-imap",
        .kakao: "/api/kakao-imap", .yahoo: "/api/yahoo-imap", .aol: "/api/aol-imap",
        .fastmail: "/api/fastmail-imap", .zoho: "/api/zoho-imap", .zohopro: "/api/zohopro-imap",
    ]
    check("every provider has its own /api/<slug>-imap route family",
          routes.count == ImapMailProvider.allCases.count
              && ImapMailProvider.allCases.allSatisfy { p in
                  routes[p].map { prefix in
                      p.statusPath == prefix + "/status" && p.connectPath == prefix + "/connect"
                          && p.disconnectPath == prefix + "/disconnect"
                  } ?? false
              })
    // The provider's own domain, so a typo'd or look-alike link fails here.
    let helpDomains: [ImapMailProvider: String] = [
        .icloud: "appleid.apple.com", .daum: "daum.net", .kakao: "kakao.com", .yahoo: "yahoo.com",
        .aol: "aol.com", .fastmail: "fastmail.help", .zoho: "zoho.com", .zohopro: "zoho.com",
    ]
    check("every preset's app-password link is https on the provider's own domain",
          ImapMailProvider.allCases.filter(\.usesPresetCopy).allSatisfy { p in
              guard let url = p.appPasswordHelpURL, let host = url.host?.lowercased(),
                    let domain = helpDomains[p] else { return false }
              return url.scheme == "https" && (host == domain || host.hasSuffix("." + domain))
          })
    check("only Naver and iCloud keep their own copy; every other case is a preset",
          ImapMailProvider.allCases.filter { !$0.usesPresetCopy } == [.naver, .icloud])
    check("each preset's address placeholder is a placeholder, never a real-looking person",
          ImapMailProvider.allCases.allSatisfy { $0.emailPlaceholder.hasPrefix("you@") }
              && Set(ImapMailProvider.allCases.map(\.emailPlaceholder)).count == ImapMailProvider.allCases.count)
    check("every preset has its own row label, glyph and VoiceOver name (never the generic one)",
          ImapMailProvider.allCases.allSatisfy { p in
              providerLabel(p.rawValue) != L("inbox.provider.generic")
                  && sourceMonogram(provider: p.rawValue) != "@"
                  && sourceName(provider: p.rawValue) != L("source.generic")
          }
              && sourceMonogram(provider: "KAKAO") != sourceMonogram(provider: "KLORN")
              && providerLabel("ZOHO") != providerLabel("ZOHOPRO"))

    // MARK: 2. request shape
    let body = (try? ImapConnectRequest.body(email: "  \(fakeEmail)\n", password: fakePassword)) ?? Data()
    let decoded = (try? JSONSerialization.jsonObject(with: body)) as? [String: String] ?? [:]
    check("the body is exactly { email, password } — no host, nothing else",
          Set(decoded.keys) == ["email", "password"])
    let pasted = (try? ImapConnectRequest.body(email: fakeEmail, password: " \(fakePassword)\n")) ?? Data()
    let pastedBody = (try? JSONSerialization.jsonObject(with: pasted)) as? [String: String] ?? [:]
    check("the email and a pasted password are trimmed",
          decoded["email"] == fakeEmail && decoded["password"] == fakePassword
              && pastedBody["password"] == fakePassword)
    check("editing either field clears a shown error",
          text("ImapConnectForm.swift").contains(".onChange(of: password) { failure = nil }"))
    check("the password travels only over HTTPS (or plain http to this Mac in dev)",
          ImapConnectRequest.isSecureBase("https://app.klorn.ai")
              && ImapConnectRequest.isSecureBase("http://localhost:4000")
              && ImapConnectRequest.isSecureBase("http://127.0.0.1:4000")
              && !ImapConnectRequest.isSecureBase("http://app.klorn.ai")
              && !ImapConnectRequest.isSecureBase("http://localhost.evil.example")
              && !ImapConnectRequest.isSecureBase("ftp://app.klorn.ai")
              && !ImapConnectRequest.isSecureBase(""))

    // MARK: 3. error mapping
    func failure(_ status: Int, _ code: String?, _ message: String?) -> ImapConnectFailure {
        ImapConnectFailure.classify(ImapConnectRejection(status: status, code: code, message: message))
    }
    check("IMAP_AUTH_FAILED → the app-password message",
          failure(400, "IMAP_AUTH_FAILED", "iCloud IMAP login failed.") == .appPasswordRejected)
    check("an older server's auth hint still reads as the app-password message",
          failure(400, nil, "iCloud IMAP login failed. Generate an app-specific password…") == .appPasswordRejected)
    check("IMAP_UNREACHABLE and 'Could not reach' → unreachable",
          failure(400, "IMAP_UNREACHABLE", "Could not reach x") == .unreachable  // wire-value
              && failure(400, nil, "Could not reach imap.mail.me.com:993: timeout") == .unreachable)
    check("the per-provider account cap → too many accounts",
          failure(400, nil, "At most 10 iCloud accounts.") == .tooManyAccounts)
    check("a schema refusal of the address → invalid email",
          failure(400, nil, "body/email must match format \"email\"") == .invalidEmail)
    check("429 → rate limited", failure(429, nil, "Rate limit exceeded") == .rateLimited)  // wire-value
    check("404 → iCloud Mail not available yet (flag off)", failure(404, nil, nil) == .unavailable)
    check("an unknown 400 never shows raw server text", failure(400, nil, "odd") == .generic)
    check("a bare 500 → the generic failure", failure(500, nil, nil) == .generic)
    check("403 (second mailbox on Free) → needs Pro",
          ImapConnectFailure.classify(APIError.forbidden) == .needsPro)
    check("offline → offline",
          ImapConnectFailure.classify(APIError.transport("x", code: URLError.notConnectedToInternet.rawValue))
              == .offline)
    check("the refused-insecure transport has its own reason",
          ImapConnectFailure.classify(ImapConnectRequest.InsecureTransport()) == .insecureTransport)
    let iCloudAuth = ImapConnectFailure.appPasswordRejected.message(for: .icloud)
    check("iCloud's auth message names the app-specific password, not Naver's",
          iCloudAuth == L("account.icloud.error.authFailed")
              && iCloudAuth != ImapConnectFailure.appPasswordRejected.message(for: .naver))
    let every: [ImapConnectFailure] = [
        .appPasswordRejected, .unreachable, .tooManyAccounts, .invalidEmail, .rateLimited,
        .needsPro, .unavailable, .offline, .insecureTransport, .generic,
    ]
    check("every failure reads as a non-empty, translated sentence for every provider",
          every.allSatisfy { f in
              ImapMailProvider.allCases.allSatisfy { p in
                  let m = f.message(for: p)
                  return !m.isEmpty && !m.contains("account.") && !m.contains("%")
              }
          })
    check("a preset's refusals name the preset",
          ImapMailProvider.allCases.filter(\.usesPresetCopy).allSatisfy { p in
              ImapConnectFailure.appPasswordRejected.message(for: p).contains(p.presetName)
                  && ImapConnectFailure.unavailable.message(for: p).contains(p.presetName)
          })
    check("every provider's form copy is translated (no raw key, no unfilled format)",
          ImapMailProvider.allCases.allSatisfy { p in
              let copy = [p.connectLabel, p.formTitle, p.emailLabel, p.passwordLabel, p.passwordHint]
                  + [p.bodyText, p.helpLinkLabel].compactMap { $0 }
              return copy.allSatisfy { !$0.isEmpty && !$0.contains("account.") && !$0.contains("%") }
          })
    check("a preset's connect button and title name the preset",
          ImapMailProvider.allCases.filter(\.usesPresetCopy).allSatisfy { p in
              p.connectLabel.contains(p.presetName) && p.formTitle.contains(p.presetName)
                  && p.helpLinkLabel != nil
          })

    // MARK: 4. field rules
    check("the fake iCloud fixture may be submitted",
          canSubmitImapConnect(email: fakeEmail, password: fakePassword))
    check("blank, short or overlong passwords may not",
          !canSubmitImapConnect(email: fakeEmail, password: "")
              && !canSubmitImapConnect(email: fakeEmail, password: "abc")
              && !canSubmitImapConnect(email: fakeEmail, password: String(repeating: "a", count: 201)))
    check("addresses the server's format refuses are refused here first",
          !canSubmitImapConnect(email: "a:b@icloud.example", password: fakePassword)
              && !canSubmitImapConnect(email: "a\\b@icloud.example", password: fakePassword)
              && !canSubmitImapConnect(email: "a@b@icloud.example", password: fakePassword)
              && !canSubmitImapConnect(email: "you@icloud", password: fakePassword)
              && !canSubmitImapConnect(
                  email: String(repeating: "a", count: 190) + "@icloud.example", password: fakePassword))
    check("surrounding whitespace is fine (trimmed before sending)",
          canSubmitImapConnect(email: "  \(fakeEmail) ", password: fakePassword))
    check("a connect in flight disables the button (no double submit)",
          !ImapConnectForm.canSubmit(email: fakeEmail, password: fakePassword, isConnecting: true)
              && ImapConnectForm.canSubmit(email: fakeEmail, password: fakePassword, isConnecting: false))

    // MARK: 5. the password stays in memory, in one request
    let product = files.filter { !$0.lastPathComponent.hasPrefix("SelfCheck") }
        .filter { !$0.lastPathComponent.hasPrefix("PreviewRender") }
    let leakyLines = product.flatMap { url -> [String] in
        let source = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        return source.split(separator: "\n").map(String.init).filter { line in
            let code = line.trimmingCharacters(in: .whitespaces)
            guard !code.hasPrefix("//") else { return false }
            return code.range(of: "password", options: .caseInsensitive) != nil
                && storageNeedles.contains { code.contains($0) }
        }
    }
    check("no source line logs or stores a password", leakyLines.isEmpty)
    if !leakyLines.isEmpty { print("      leaky: \(leakyLines.joined(separator: " | "))") }
    let form = text("ImapConnectForm.swift")
    check("the form uses a SecureField for the app password", form.contains("SecureField("))
    check("the form clears its fields when it closes",
          form.contains(".onDisappear") && form.contains("password = \"\""))
    check("the form opens appleid.apple.com in the default browser (no web view)",
          form.contains("NSWorkspace.shared.open") && !form.contains("WKWebView"))
    check("the form shows the Beta chip", form.contains("BetaChip()"))
    check("the form never offers the password to AutoFill / Passwords", !form.contains("textContentType"))
    let model = text("AppModel.swift")
    check("the model's connect refuses a second submit while one is in flight",
          model.contains("guard !isConnectingImap else { return .ignored }"))

    let listed = inboxesNotListedAsImap(
        [
            InboxOption(id: nil, email: "me@gmail.example", kind: "primary", needsReconnect: false,
                        provider: "GOOGLE", purpose: nil),
            InboxOption(id: "li-1", email: "You@iCloud.example", kind: "linked", needsReconnect: false,
                        provider: "ICLOUD", purpose: nil),
            InboxOption(id: "li-2", email: "other@icloud.example", kind: "linked", needsReconnect: false,
                        provider: "ICLOUD", purpose: nil),
        ],
        imap: [.icloud: [ImapAccount(email: fakeEmail, host: "imap.mail.me.com:993", connectedAt: nil,
                                     lastSyncedAt: nil, needsReconnect: false)]])
    check("a mailbox the iCloud list shows is not listed twice (address case ignored)",
          listed.map(\.selectionValue) == ["primary", "li-2"])

    // MARK: 6. entry points
    let prefs = text("PreferencesView.swift")
    check("settings ▸ Accounts draws one connect button per offered provider",
          prefs.contains("ForEach(offeredImapProviders(model.availableImapProviders))")
              && prefs.contains("connectButton(provider, title: provider.connectLabel)"))
    check("every provider opens the one parameterized form",
          prefs.contains("ImapConnectForm(provider: provider") && prefs.contains("connectingProvider = provider"))
    check("Naver is always offered; a gated provider only once its status answered",
          offeredImapProviders([]) == [.naver]
              && offeredImapProviders([.zohopro, .daum, .icloud]) == [.naver, .icloud, .daum, .zohopro]
              && offeredImapProviders(Set(ImapMailProvider.allCases)) == ImapMailProvider.allCases)
    check("a fresh session offers Naver only — the presets wait for their probe",
          AppModel(tokenStore: InMemoryTokenStore()).availableImapProviders == [.naver])
    check("the status probe covers every provider; a 404 hides any but Naver",
          model.contains("for provider in ImapMailProvider.allCases { await refreshImapAccounts(provider) }")
              && model.contains("guard isCurrent(session), provider != .naver else { return }"))
    let probeCallers = product.filter {
        ((try? String(contentsOf: $0, encoding: .utf8)) ?? "").contains("model.refreshImapAccounts()")
    }.map(\.lastPathComponent)
    check("the probe runs only when Settings ▸ Accounts opens (no polling)",
          probeCallers == ["PreferencesView.swift"]
              && prefs.components(separatedBy: "model.refreshImapAccounts()").count == 2
              && prefs.contains(".task { await model.refreshImapAccounts() }"))

    // MARK: 7. copy, in every catalogue
    let keys = [
        "account.icloud.connect", "account.icloud.title", "account.icloud.body", "account.icloud.email",
        "account.icloud.password", "account.icloud.password.hint", "account.icloud.help.link",
        "account.icloud.error.authFailed", "account.naver.title", "account.naver.error.authFailed",
        "account.imap.connecting", "account.imap.error.unreachable", "account.imap.error.tooMany",
        "account.imap.error.invalidEmail", "account.imap.error.needsPro", "account.imap.error.offline",
        "account.icloud.error.unavailable", "account.naver.error.unavailable",
        "account.imap.error.insecure", "account.imap.submit",
        "account.preset.body", "account.preset.email", "account.preset.password",
        "account.preset.password.either",
    ]
    // The preset sentences take the preset's name as their one %@ (a string:
    // a %d here would be the pointer-read crash).
    let presetFormats = [
        "account.preset.connect", "account.preset.title", "account.preset.help.link",
        "account.preset.error.authFailed", "account.preset.error.unavailable",
    ]
    let presetStems = ImapMailProvider.allCases.filter(\.usesPresetCopy).map { $0.rawValue.lowercased() }
    let perPreset = presetStems.flatMap { ["account.\($0).name", "account.\($0).password.hint"] }
    for language in ["en", "ko", "ja", "zh", "es", "fr", "de"] {
        let url = sourceDir.appendingPathComponent("Resources/\(language).lproj/Localizable.strings")
        let table = NSDictionary(contentsOf: url) as? [String: String] ?? [:]
        let missing = (keys + presetFormats + perPreset).filter { (table[$0] ?? "").isEmpty }
        check("\(language): every connect-sheet string is translated", missing.isEmpty)
        if !missing.isEmpty { print("      missing: \(missing.joined(separator: ", "))") }
        let badFormats = presetFormats.filter { key in
            let value = table[key] ?? ""
            return value.components(separatedBy: "%@").count != 2
                || value.replacingOccurrences(of: "%@", with: "").contains("%")
        }
        check("\(language): each preset sentence takes exactly one %@ (the name)", badFormats.isEmpty)
        if !badFormats.isEmpty { print("      bad formats: \(badFormats.joined(separator: ", "))") }
        let unfilled = presetStems.flatMap { stem in
            presetFormats.compactMap { key -> String? in
                let name = table["account.\(stem).name"] ?? ""
                let line = String(format: table[key] ?? "", name)
                return !name.isEmpty && line.contains(name) && !line.contains("%") ? nil : "\(stem):\(key)"
            }
        }
        check("\(language): every preset sentence reads with the preset's name in it", unfilled.isEmpty)
        if !unfilled.isEmpty { print("      unfilled: \(unfilled.joined(separator: ", "))") }
        check("\(language): it says iCloud Mail (beta), never Apple Mail",
              (table["account.icloud.body"] ?? "").contains("iCloud Mail")
                  && !table.values.contains { $0.contains(retiredName) })
    }
    check("en: the sheet body says iCloud Mail (beta)", L("account.icloud.body").contains("iCloud Mail (beta)"))
    return results
}

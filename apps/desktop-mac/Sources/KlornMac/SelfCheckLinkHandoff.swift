import Foundation

// Self-check for the account-link hand-off (OAuth link binding fix), run by
// `KlornMac --self-check`.
//
// The OAuth callback no longer stores a linked account itself: it parks the
// consent under a one-time handle and deep-links `klorn://link-complete?h=…`
// back here. The app finishes the link with its OWN session, so a consent
// that another Klorn account started is never attached to this one. These
// checks pin the parser, the start routes, the reply mapping, and the model
// driven against a stubbed network (no browser, no Keychain, no real server).

/// Every link hand-off check, as (name, passed).
@MainActor
func linkHandoffSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results = linkHandleParseChecks()
    results += linkReplyChecks()
    results += await linkCompleteModelChecks()
    results += linkStringChecks()
    results += linkWiringChecks(sourceDir: sourceDir)
    return results
}

/// 64 lowercase hex characters: the shape the server mints (32 random bytes).
private let sampleHandle = String(repeating: "0123456789abcdef", count: 4)

private func parsed(_ string: String) -> String? {
    URL(string: string).flatMap(AuthFlow.linkHandle(from:))
}

private func linkHandleParseChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let h = sampleHandle

    check("a link hand-off URL yields its handle",
          parsed("klorn://link-complete?h=\(h)") == h)
    check("another scheme is refused",
          parsed("evil://link-complete?h=\(h)") == nil
          && parsed("https://link-complete?h=\(h)") == nil
          && parsed("ai.klorn.app://link-complete?h=\(h)") == nil)
    check("another host is refused",
          parsed("klorn://oauth-callback?h=\(h)") == nil
          && parsed("klorn://link-completed?h=\(h)") == nil
          && parsed("klorn://evil.example?h=\(h)") == nil
          && parsed("klorn:link-complete?h=\(h)") == nil)
    check("a handle of the wrong length is refused",
          parsed("klorn://link-complete?h=\(h.dropLast())") == nil
          && parsed("klorn://link-complete?h=\(h)0") == nil
          && parsed("klorn://link-complete?h=\(h)\(h)") == nil)
    check("an uppercase or non-hex handle is refused",
          parsed("klorn://link-complete?h=\(h.uppercased())") == nil
          && parsed("klorn://link-complete?h=\(h.dropLast())A") == nil
          && parsed("klorn://link-complete?h=\(h.dropLast())g") == nil
          && parsed("klorn://link-complete?h=\(h.dropLast())-") == nil)
    check("a missing or empty h is refused",
          parsed("klorn://link-complete") == nil
          && parsed("klorn://link-complete?") == nil
          && parsed("klorn://link-complete?h=") == nil
          && parsed("klorn://link-complete?h") == nil
          && parsed("klorn://link-complete?code=\(h)") == nil
          && parsed("klorn://link-complete?H=\(h)") == nil)
    check("extra query items, a repeated h, a path, a fragment or a port are refused",
          parsed("klorn://link-complete?h=\(h)&x=1") == nil
          && parsed("klorn://link-complete?x=1&h=\(h)") == nil
          && parsed("klorn://link-complete?h=\(h)&h=\(h)") == nil
          && parsed("klorn://link-complete/x?h=\(h)") == nil
          && parsed("klorn://link-complete?h=\(h)#f") == nil
          && parsed("klorn://link-complete:80?h=\(h)") == nil
          && parsed("klorn://u@link-complete?h=\(h)") == nil)
    check("a percent-encoded handle is refused (only the raw form passes)",
          parsed("klorn://link-complete?h=%30\(h.dropFirst())") == nil
          && parsed("klorn://link-complete?%68=\(h)") == nil)
    check("the sign-in relay and the link hand-off never take each other's URL",
          AuthFlow.relayCode(from: URL(string: "klorn://link-complete?h=\(h)")!) == nil
          && parsed("klorn://oauth-callback?code=\(h)") == nil)
    check("isLinkHandle is the same shape test",
          AuthFlow.isLinkHandle(h) && !AuthFlow.isLinkHandle(h.uppercased())
          && !AuthFlow.isLinkHandle("") && !AuthFlow.isLinkHandle(String(h.dropLast())))
    // Old server: no querystring schema on these POST routes, so the extra
    // query is ignored and today's flow runs unchanged.
    check("the Google connect and account-link starts ask for the app hand-off",
          GoogleConnectFlow.startPath == "/api/auth/google/start?appScheme=klorn"
          && LinkInboxFlow.startPath == "/api/auth/google/link-inbox?appScheme=klorn")
    return results
}

private func linkReplyChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    func reply(_ json: String) -> LinkCompletion { AuthFlow.linkCompletion(reply: Data(json.utf8)) }

    check("a 2xx next naming success is a landed link",
          reply(#"{"next":"/settings?inbox=success"}"#) == .linked
          && reply(#"{"next":"/settings?google=connected"}"#) == .linked
          && reply(#"{"next":"/calendar?linked=success"}"#) == .linked)
    check("a 2xx with no readable next still counts as landed (the refresh shows the truth)",
          reply("{}") == .linked && reply("not json") == .linked
          && reply(#"{"next":"/settings"}"#) == .linked)
    check("a 2xx next naming the paywall asks for Pro",
          reply(#"{"next":"/settings?inbox=pro"}"#) == .needsPro
          && reply(#"{"next":"/settings?google=pro"}"#) == .needsPro)
    check("any other 2xx result is a failure, never a silent success",
          ["limit", "self", "failed", "unverified", "mismatch"].allSatisfy {
              reply(#"{"next":"/settings?inbox=\#($0)"}"#) == .failed
          }
          && reply(#"{"next":"/settings?google=offline_access_denied"}"#) == .failed
          && reply(#"{"next":"/calendar?linked=failed"}"#) == .failed)
    check("409 is a mismatch, 404 an expired hand-off, any other status a failure",
          AuthFlow.linkCompletion(status: 409) == .mismatch
          && AuthFlow.linkCompletion(status: 404) == .expired
          && AuthFlow.linkCompletion(status: 500) == .failed
          && AuthFlow.linkCompletion(status: 429) == .failed)
    return results
}

@MainActor
private func linkCompleteModelChecks() async -> [(String, Bool)] {
    typealias Stub = SessionStubProtocol
    typealias S = SessionScenarios
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let complete = "POST /api/auth/link/complete"
    let inboxes = "GET /api/email/inboxes"
    let success = Stub.Reply(body: #"{"next":"/settings?inbox=success"}"#)

    let linked = S.model([complete: success])
    await linked.completeLink(handle: sampleHandle)
    check("signed in: the hand-off completes under this app's own session, then the accounts refresh",
          Stub.calls(complete).map(\.bearer) == ["Bearer token-A"]
          && !Stub.calls(inboxes).isEmpty && linked.linkAccountError == nil)
    await linked.completeLink(handle: sampleHandle)
    check("the same hand-off delivered twice is completed once (no false 'expired')",
          Stub.calls(complete).count == 1 && linked.linkAccountError == nil)

    let mismatch = S.model([complete: .init(status: 409, body: #"{"next":"/settings?inbox=mismatch"}"#)])
    await mismatch.completeLink(handle: sampleHandle)
    check("409: another account started the link — the mismatch message, no refresh",
          mismatch.linkAccountError == L("account.link.mismatch") && Stub.calls(inboxes).isEmpty
          && mismatch.phase == .signedIn)

    let expired = S.model([complete: .init(status: 404)])
    await expired.completeLink(handle: sampleHandle)
    check("404: the hand-off expired or was spent — the try-again message",
          expired.linkAccountError == L("account.link.expired") && Stub.calls(inboxes).isEmpty)

    let capped = S.model([complete: .init(body: #"{"next":"/settings?inbox=limit"}"#)])
    await capped.completeLink(handle: sampleHandle)
    let pro = S.model([complete: .init(body: #"{"next":"/settings?inbox=pro"}"#)])
    await pro.completeLink(handle: sampleHandle)
    check("a 2xx that reports a refusal says so (Pro, or the generic failure)",
          capped.linkAccountError == L("account.link.failed")
          && pro.linkAccountError == L("error.needsPro"))

    let rejected = S.model([complete: .init(status: 401)])
    await rejected.completeLink(handle: sampleHandle)
    check("401: the session is rejected as everywhere else", rejected.phase == .signedOut)

    let refused = S.model([complete: success])
    await refused.completeLink(handle: sampleHandle.uppercased())
    check("the model refuses a malformed handle without a request", Stub.calls(complete).isEmpty)

    // Cold launch while signed out: nothing to complete under yet.
    let cold = S.model([complete: success], token: nil)
    await cold.completeLink(handle: sampleHandle)
    let waited = Stub.calls(complete).isEmpty
    cold.beginSessionForCheck(token: "token-B")
    let posted = await S.waitUntil { Stub.calls(complete).count == 1 }
    check("no session yet: the hand-off waits, then completes once a sign-in lands",
          waited && posted && Stub.calls(complete).first?.bearer == "Bearer token-B")
    return results
}

private func linkStringChecks() -> [(String, Bool)] {
    func table(_ code: String) -> [String: String] {
        guard let path = Bundle.module.path(forResource: code, ofType: "lproj"),
              let url = Bundle(path: path)?.url(forResource: "Localizable", withExtension: "strings"),
              let dict = NSDictionary(contentsOf: url) as? [String: String]
        else { return [:] }
        return dict
    }
    let keys = ["account.link.mismatch", "account.link.expired", "account.link.failed"]
    let missing = L10n.shipped.flatMap { code in
        let strings = table(code)
        return keys.filter { (strings[$0] ?? "").isEmpty || strings[$0]?.contains("%") == true }
            .map { "\(code):\($0)" }
    }
    if !missing.isEmpty { print("      missing: \(missing.joined(separator: ", "))") }
    return [("the hand-off messages exist in every shipped language, with no format specifiers",
             missing.isEmpty)]
}

private func linkWiringChecks(sourceDir: URL) -> [(String, Bool)] {
    let app = swiftSources(under: sourceDir)
        .first { $0.lastPathComponent == "KlornApp.swift" }
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    return [("the URL handler routes a link hand-off to the model",
             app.contains("} else if let handle = AuthFlow.linkHandle(from: url) {")
             && app.contains("Task { await model.completeLink(handle: handle) }"))]
}

import Foundation

// Self-check for the token-store seam, run by `KlornMac --self-check`.
//
// The harnesses (`--render-previews`, `--self-check`) run as an unsigned binary.
// One Keychain read from there blocks on a macOS permission dialog and, if
// allowed, hands the harness the developer's real session token. These checks
// pin that no harness file can reach the Keychain and that the shipped app
// still does.

/// Every token-store check, as (name, passed).
func tokenStoreSelfChecks(sourceDir: URL) -> [(String, Bool)] {
    // Feature subfolders included: a flat listing would skip most of the views.
    let sourceFiles = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        sourceFiles.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    let sources = sourceFiles.map(\.lastPathComponent).sorted()
    func containing(_ needle: String) -> [String] { sources.filter { text($0).contains(needle) } }

    // Needles are assembled so this file does not match its own search.
    let keychain = "Keychain"
    let secItem = "Sec" + "Item"
    let staticCalls = ["load(", "save(", "clear("].map { keychain + "Store." + $0 }
    func callsKeychain(_ source: String) -> Bool { staticCalls.contains { source.contains($0) } }
    let productionStore = keychain + "TokenStore" + "("
    let defaultModel = "AppModel" + "()"
    let harnessFiles = sources.filter { $0 == "PreviewRender.swift" || $0.hasPrefix("SelfCheck") }
    let harnessOffenders = harnessFiles.filter { file in
        let source = text(file)
        return callsKeychain(source)
            || [secItem, productionStore, defaultModel].contains { source.contains($0) }
    }

    let memory = InMemoryTokenStore()
    let startsEmpty = memory.load() == nil
    let saved = memory.save("jwt-1") && memory.load() == "jwt-1"
    let overwritten = memory.save("jwt-2") && memory.load() == "jwt-2"
    memory.clear()
    let cleared = memory.load() == nil
    let isolated = InMemoryTokenStore(token: "seed").load() == "seed" && memory.load() == nil

    let appModel = text("AppModel.swift")
    let tokenStore = text("TokenStore.swift")

    return [
        ("the harness sources are readable",
         harnessFiles.contains("PreviewRender.swift") && harnessFiles.contains("SelfCheck.swift")
         && !appModel.isEmpty && !tokenStore.isEmpty),
        ("no harness file calls the Keychain or builds a model on the default store",
         harnessOffenders.isEmpty),
        ("the preview renderer builds its model on the in-memory store",
         text("PreviewRender.swift").contains("AppModel(tokenStore: InMemoryTokenStore())")),
        ("the Security framework is called from the Keychain store alone",
         containing(secItem) == ["KeychainStore.swift"]),
        ("the Keychain store is reached only through the seam and the two production defaults",
         sources.filter { callsKeychain(text($0)) } == ["APIClient.swift", "DeviceCalendarBridge.swift", "TokenStore.swift"]),
        ("the in-memory store round-trips: empty, save, overwrite, clear",
         startsEmpty && saved && overwritten && cleared && isolated),
        ("the app's default token store is the Keychain store",
         type(of: AppModel.productionTokenStore()) == KeychainTokenStore.self
         && appModel.contains("init(tokenStore: any TokenStore = AppModel.productionTokenStore(), api: APIClient? = nil)")
         && text("KlornApp.swift").contains("let model = " + defaultModel)),
        ("the Keychain store forwards to the same Keychain item as before",
         tokenStore.contains("func load() -> String? { " + staticCalls[0] + ") }")
         && tokenStore.contains("func save(_ token: String) -> Bool { " + staticCalls[1] + "token) }")
         && tokenStore.contains("func clear() { " + staticCalls[2] + ") }")
         && Config.keychainService == "ai.klorn.desktop" && Config.keychainAccount == "klorn-token"),
        ("the model reads and writes the token through its store only",
         !callsKeychain(appModel)
         && appModel.contains("APIClient(token: { tokenStore.load() })")
         && appModel.contains("SessionIdentity.userId(fromToken: tokenStore.load())")),
    ]
}

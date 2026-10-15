import Foundation
import os

// Self-check for P12 on macOS (Files + Teams free-time), run by
// `KlornMac --self-check`: the /me gating, the request shapes, the URL
// validation before anything is opened, the free-time scope and staleness,
// and the strings. Network is a stub URLProtocol; nothing reaches a server,
// nothing is opened outside the process.

/// Answers the scenarios' URLSession by "METHOD /path" and records each call.
final class FilesStubProtocol: URLProtocol, @unchecked Sendable {
    struct Call: Sendable, Equatable {
        let path: String
        let query: String
    }
    struct Reply: Sendable {
        let status: Int
        let body: String
        /// Answer this long after the request starts (a response "in flight").
        var delayMs = 0
    }

    static let state = OSAllocatedUnfairLock(initialState: (replies: [String: Reply](), calls: [Call]()))

    static func reset(_ replies: [String: Reply]) { state.withLock { $0 = (replies, []) } }
    static var calls: [Call] { state.withLock { $0.calls } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let call = Call(path: url.path, query: components?.percentEncodedQuery ?? "")
        // "path?query" answers one exact request; "path" answers the rest.
        let reply: Reply = Self.state.withLock { state in
            state.calls.append(call)
            return state.replies["\(url.path)?\(call.query)"] ?? state.replies[url.path]
                ?? Reply(status: 404, body: #"{"error":"not found"}"#)
        }
        guard reply.delayMs > 0 else { return answer(reply, url: url) }
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(reply.delayMs)) { [self] in
            answer(reply, url: url)
        }
    }

    private func answer(_ reply: Reply, url: URL) {
        let response = HTTPURLResponse(
            url: url, statusCode: reply.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])
        if let response { client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed) }
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
enum FilesScenarios {
    static func api() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FilesStubProtocol.self]
        return APIClient(base: "http://stub.test", session: URLSession(configuration: configuration), token: { "t" })
    }

    static func ok(_ body: String) -> FilesStubProtocol.Reply { .init(status: 200, body: body) }

    static func fileJSON(
        id: String, provider: String = "KLORN", folder: Bool = false, webUrl: String? = nil,
        name: String? = nil
    ) -> String {
        let web = webUrl.map { "\"\($0)\"" } ?? "null"
        return #"{"id":"\#(id)","provider":"\#(provider)","sourceKey":"k","externalId":"ext-\#(id)","name":"\#(name ?? id)","mimeType":null,"isFolder":\#(folder),"sizeBytes":\#(folder ? "null" : "2048"),"parentExternalId":null,"modifiedAt":"2026-10-14T09:00:00.000Z","webUrl":\#(web),"readOnly":\#(provider != "KLORN")}"#
    }

    static func file(
        id: String, provider: String = "KLORN", folder: Bool = false, webUrl: String? = nil
    ) -> DriveFileWire {
        DriveFileWire(
            id: id, provider: provider, externalId: "ext-\(id)", name: id, mimeType: nil,
            isFolder: folder, sizeBytes: folder ? nil : 2048, modifiedAt: "2026-10-14T09:00:00.000Z",
            webUrl: webUrl)
    }

    static func page(_ files: [String], next: String? = nil) -> FilesStubProtocol.Reply {
        ok(#"{"files":[\#(files.joined(separator: ","))],"nextCursor":\#(next.map { "\"\($0)\"" } ?? "null")}"#)
    }
}

/// Every P12 check, as (name, passed).
@MainActor
func filesSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    results += filesGatingChecks()
    results += filesRequestChecks()
    results += filesURLChecks()
    results += freeTimeRuleChecks()
    results += await filesStoreChecks()
    results += await freeTimeStoreChecks()
    results += await filesModelChecks()
    results += await filesRaceChecks()
    results += filesStringChecks()
    results += filesSourcePins(sourceDir: sourceDir)
    return results.map { ("P12 — \($0.0)", $0.1) }
}

// MARK: Gating

@MainActor
private func filesGatingChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    func flags(_ json: String) -> ClientFlags? {
        try? JSONDecoder().decode(MeFlagsResponse.self, from: Data(json.utf8)).user
    }
    check("/me without the flags (an older server): Files and team mode off",
          flags(#"{"user":{"id":"u1","email":"a@b.example"}}"#) == ClientFlags())
    check("/me with files and teamMode true: both on",
          flags(#"{"user":{"files":true,"teamMode":true}}"#) == ClientFlags(files: true, teamMode: true))
    check("/me with a non-boolean flag: off, and the rest still decodes",
          flags(#"{"user":{"files":"yes","teamMode":true}}"#) == ClientFlags(files: false, teamMode: true))
    check("Files is in the nav only with the files flag (FD-7)",
          !FilesRules.sections(files: false).contains(.files)
          && FilesRules.sections(files: true) == [.today, .mail, .calendar, .files, .assistant])
    var menu = MenuState(
        signedIn: true, fullViewOpen: true, mailSurfaceIsKey: true, modalOpen: false, targetTier: nil,
        emailLoaded: false, readerReplying: false, teamModeAvailable: false, listHasSearchField: true)
    let offFiles = MenuRules.isEnabled(.section(.files), in: menu)
    menu.filesAvailable = true
    check("Go ▸ Files is enabled only with the files flag",
          !offFiles && MenuRules.isEnabled(.section(.files), in: menu)
          && MenuRules.isEnabled(.section(.today), in: menu))
    check("Files has no reader: entering it drops the mail selection",
          !NavRules.readerVisible(macMainWindow: true, section: .files)
          && NavRules.clearsSelection(macMainWindow: true, section: .files)
          && NavRules.listMode(entering: .files, nav: MainNav(), current: .inbox) == nil)
    check("the Files section with its flag off shows and lights Today",
          FilesRules.displayed(.files, files: false) == .today
          && FilesRules.displayed(.files, files: true) == .files
          && FilesRules.displayed(.mail, files: false) == .mail)
    check("free time is offered only with team mode on and a saved team",
          FreeTimeRules.visible(teamMode: true, teamCount: 1)
          && !FreeTimeRules.visible(teamMode: true, teamCount: 0)
          && !FreeTimeRules.visible(teamMode: false, teamCount: 3))
    return results
}

// MARK: Request shapes

@MainActor
private func filesRequestChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    check("list: limit only for the plain list",
          FilesRules.listPath() == "/api/drive/files?limit=50")
    check("list: limit, q, cursor, folder in the web's order, URL-encoded",
          FilesRules.listPath(query: "  q3 plan&x ", cursor: "c/1", folder: "ext 9")
              == "/api/drive/files?limit=50&q=q3%20plan%26x&cursor=c%2F1&folder=ext%209")
    check("list: a search is cut at 100 characters, a blank one is not sent",
          FilesRules.listPath(query: String(repeating: "a", count: 150))
              == "/api/drive/files?limit=50&q=" + String(repeating: "a", count: 100)
          && FilesRules.listPath(query: "   ") == "/api/drive/files?limit=50")
    check("recent: five rows",
          FilesRules.listPath(limit: FilesRules.recentLimit) == "/api/drive/files?limit=5")
    check("download: the id is path-escaped",
          FilesRules.downloadLinkPath(id: "a/b") == "/api/drive/files/a%2Fb/download")
    let now = ISO8601DateFormatter().date(from: "2026-10-15T01:00:00Z") ?? Date()
    check("free time: next 7 days, 30-minute slots, ISO instants",
          FreeTimeRules.availabilityPath(teamId: "t1", now: now)
              == "/api/teams/t1/availability?window_start=2026-10-15T01%3A00%3A00.000Z"
              + "&window_end=2026-10-22T01%3A00%3A00.000Z&duration_minutes=30")
    return results
}

// MARK: URL validation

@MainActor
private func filesURLChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let web = FilesRules.safeWebURL
    check("an external row opens only an https link with a host and no credentials",
          web("https://drive.google.com/file/d/1") != nil
          && web("http://drive.google.com/file/d/1") == nil
          && web("javascript:alert(1)") == nil
          && web("data:text/html,x") == nil
          && web("/relative") == nil
          && web("//evil.example/x") == nil
          && web("https://user:pw@drive.example/x") == nil
          && web("https://user@drive.example/x") == nil
          && web(nil) == nil && web("") == nil)
    let local = "http://localhost:4000"
    func signed(_ raw: String?) -> URL? { FilesRules.safeDownloadURL(raw, apiBase: local) }
    check("a signed link is opened only when https, credential-free (or http to loopback)",
          signed("https://store.example/o?sig=1") != nil
          && signed("http://localhost:9000/o") != nil
          && signed("http://127.0.0.1:9000/o") != nil
          && signed("http://store.example/o") == nil
          && signed("https://a:b@store.example/o") == nil
          && signed("javascript:alert(1)") == nil
          && signed("file:///etc/passwd") == nil
          && signed("/api/x") == nil && signed("") == nil && signed(nil) == nil)
    check("http to loopback only while the API itself is local; production is https only",
          FilesRules.safeDownloadURL("http://localhost:9000/o", apiBase: "https://api.klorn.example") == nil
          && FilesRules.safeDownloadURL("http://127.0.0.1:9000/o", apiBase: "https://api.klorn.example") == nil
          && FilesRules.safeDownloadURL("https://store.example/o", apiBase: "https://api.klorn.example") != nil)
    let f = FilesScenarios.file
    check("open: a Klorn folder walks in, a Klorn file downloads",
          FilesRules.openAction(for: f("a", "KLORN", true, nil)) == .folder
          && FilesRules.openAction(for: f("b", "KLORN", false, "https://x.example/ignored")) == .download)
    check("open: an external row with an https webUrl is a link; anything else is plain text",
          FilesRules.openAction(for: f("c", "GOOGLE", false, "https://docs.google.com/d/1"))
              == .link(URL(string: "https://docs.google.com/d/1")!)
          && FilesRules.openAction(for: f("d", "GOOGLE", false, "javascript:alert(1)")) == .none
          && FilesRules.openAction(for: f("e", "ONEDRIVE", false, nil)) == .none
          && FilesRules.openAction(for: f("g", "GOOGLE", true, nil)) == .none)
    check("download errors: 404 gone, 429 busy, anything else generic",
          FilesRules.downloadError(for: APIError.http(404, nil)) == .gone
          && FilesRules.downloadError(for: APIError.http(429, nil)) == .busy
          && FilesRules.downloadError(for: APIError.http(500, nil)) == .failed
          && FilesRules.downloadError(for: APIError.forbidden) == .failed
          && FilesRules.downloadError(for: APIError.transport("x")) == .failed)
    let en = Locale(identifier: "en_US")
    check("sizes read like the web's",
          FilesRules.formatSize(1536, locale: en) == "1.5 KB"
          && FilesRules.formatSize(0, locale: en) == "0 B"
          && FilesRules.formatSize(5 * 1024 * 1024, locale: en) == "5 MB"
          && FilesRules.formatSize(nil, locale: en) == "" && FilesRules.formatSize(-1, locale: en) == "")
    let trail = [FolderCrumb(id: "1", externalId: "e1", name: "A"),
                 FolderCrumb(id: "2", externalId: "e2", name: "B")]
    check("breadcrumb: cut back to a crumb, -1 is all files",
          FilesRules.trail(trail, to: 0).map(\.id) == ["1"] && FilesRules.trail(trail, to: -1).isEmpty
          && FilesRules.trail(trail, to: 5).count == 2)
    return results
}

// MARK: Free time rules

@MainActor
private func freeTimeRuleChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    typealias Slot = TeamAvailabilityWire.Slot
    func result(checked: [String], unknown: [String], slots: [Slot] = []) -> TeamAvailabilityWire {
        TeamAvailabilityWire(slots: slots, checkedMembers: checked, unknownMembers: unknown, timeZone: "Asia/Seoul")
    }
    let iso = ISO8601DateFormatter()
    let now = iso.date(from: "2026-10-15T01:00:00Z") ?? Date()
    let past = Slot(startTime: "2026-10-15T00:30:00.000Z", endTime: "2026-10-15T01:00:00.000Z")
    let soon = Slot(startTime: "2026-10-15T02:00:00.000Z", endTime: "2026-10-15T02:30:00.000Z")
    let bad = Slot(startTime: "not a date", endTime: "x")

    let selfOnly = result(checked: [], unknown: ["a@x.example", "b@x.example"])
    check("no member checked: the slots are the user's own, and the copy says so",
          FreeTimeRules.scope(selfOnly) == .selfOnly && FreeTimeRules.unknownNotice(selfOnly) == nil
         )
    let team = result(checked: ["a@x.example"], unknown: ["b@x.example", "c@x.example"])
    check("unknown members are named above the slots, never counted as free",
          FreeTimeRules.scope(team) == .team
          && FreeTimeRules.unknownNotice(team)?.hasSuffix("b@x.example, c@x.example") == true
          && FreeTimeRules.unknownNotice(result(checked: ["a@x.example"], unknown: [])) == nil)
    check("slots that have started are dropped; an unreadable one too",
          FreeTimeRules.upcoming([past, soon, bad], now: now).map(\.startTime) == [soon.startTime])
    check("stale: older than 10 minutes, an unknown fetch time, or the first slot started",
          !FreeTimeRules.stale(fetchedAt: now.addingTimeInterval(-60), slots: [soon], now: now)
          && FreeTimeRules.stale(fetchedAt: now.addingTimeInterval(-11 * 60), slots: [soon], now: now)
          && FreeTimeRules.stale(fetchedAt: nil, slots: [soon], now: now)
          && FreeTimeRules.stale(fetchedAt: now, slots: [past, soon], now: now)
          && !FreeTimeRules.stale(fetchedAt: now, slots: [], now: now))
    let seoul = TimeZone(identifier: "Asia/Seoul") ?? .current
    let label = FreeTimeRules.label(soon, locale: Locale(identifier: "en_US"), timeZone: seoul)
    check("a slot reads in the user's zone: \"Thu, Oct 15 11:00–11:30\"",
          label.contains("Oct 15") && label.contains("11:00") && label.hasSuffix("11:30")
          && FreeTimeRules.label(bad, locale: Locale(identifier: "en_US"), timeZone: seoul).isEmpty)
    check("the zone is the server's, else this Mac's",
          FreeTimeRules.timeZone(for: selfOnly).identifier == "Asia/Seoul"
          && FreeTimeRules.timeZone(for: TeamAvailabilityWire(
              slots: [], checkedMembers: [], unknownMembers: [], timeZone: "Not/AZone")) == .current)
    return results
}

// MARK: Store scenarios (stubbed network)

@MainActor
private func filesStoreChecks() async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    typealias S = FilesScenarios
    let listPath = "/api/drive/files"

    FilesStubProtocol.reset([listPath: S.page([S.fileJSON(id: "f1"), S.fileJSON(id: "d1", folder: true)], next: "c2")])
    let store = FilesStore(api: S.api())
    var opened: [URL] = []
    store.openURL = { opened.append($0); return true }
    await store.search("")
    check("list: the first page loads, with a next page",
          store.phase == .loaded && store.files.map(\.id) == ["f1", "d1"] && store.hasMore
          && FilesStubProtocol.calls.last?.query == "limit=50")

    // The next page repeats d1 (a row modified between pages moves up).
    FilesStubProtocol.reset([listPath: S.page([S.fileJSON(id: "d1", folder: true), S.fileJSON(id: "f2")])])
    await store.loadMore()
    check("paging: the cursor is passed back, rows are appended once each",
          FilesStubProtocol.calls.last?.query == "limit=50&cursor=c2"
          && store.files.map(\.id) == ["f1", "d1", "f2"] && !store.hasMore)

    FilesStubProtocol.reset([listPath: S.page([])])
    await store.search("budget")
    check("search: q is sent, and no match is an empty loaded list",
          FilesStubProtocol.calls.last?.query == "limit=50&q=budget"
          && store.phase == .loaded && store.files.isEmpty && store.appliedQuery == "budget")

    FilesStubProtocol.reset([listPath: S.page([S.fileJSON(id: "in1")])])
    await store.search("")
    await store.enter(S.file(id: "d1", folder: true))
    check("folder: walking in lists it by its externalId",
          FilesStubProtocol.calls.last?.query == "limit=50&folder=ext-d1"
          && store.trail.map(\.name) == ["d1"] && store.files.map(\.id) == ["in1"])
    await store.walk(to: -1)
    check("breadcrumb: All files lists everything again",
          store.trail.isEmpty && FilesStubProtocol.calls.last?.query == "limit=50")

    FilesStubProtocol.reset(["/api/drive/files/f1/download": S.ok(#"{"url":"https://store.example/o?sig=abc","expiresInSeconds":300}"#)])
    await store.download(S.file(id: "f1"))
    check("download: the validated signed link is handed to the browser, nothing else",
          opened == [URL(string: "https://store.example/o?sig=abc")!] && store.downloadError == nil
          && store.downloadingId == nil)

    opened = []
    FilesStubProtocol.reset(["/api/drive/files/f1/download": S.ok(#"{"url":"javascript:alert(1)","expiresInSeconds":300}"#)])
    await store.download(S.file(id: "f1"))
    let refusedScheme = opened.isEmpty && store.downloadError?.kind == .failed
    FilesStubProtocol.reset(["/api/drive/files/f1/download": S.ok(#"{"url":"https://u:p@store.example/o","expiresInSeconds":300}"#)])
    await store.download(S.file(id: "f1"))
    check("download: a non-https or credentialed link is never opened",
          refusedScheme && opened.isEmpty && store.downloadError?.kind == .failed)

    FilesStubProtocol.reset(["/api/drive/files/f1/download": .init(status: 404, body: #"{"error":"not found"}"#)])
    await store.download(S.file(id: "f1"))
    let gone = store.downloadError?.kind == .gone
    FilesStubProtocol.reset(["/api/drive/files/f1/download": .init(status: 429, body: "{}")])
    await store.download(S.file(id: "f1"))
    check("download: a gone file and the rate limit say so",
          gone && store.downloadError?.kind == .busy && opened.isEmpty)

    let link = await store.open(S.file(id: "x", provider: "GOOGLE", webUrl: "https://docs.google.com/d/1"))
    let none = await store.open(S.file(id: "y", provider: "GOOGLE", webUrl: "http://docs.google.com/d/1"))
    check("open: an external https row opens its own link; a plain-http one opens nothing",
          link == .link(URL(string: "https://docs.google.com/d/1")!) && none == .none
          && opened == [URL(string: "https://docs.google.com/d/1")!])

    FilesStubProtocol.reset([listPath: S.page([S.fileJSON(id: "r1"), S.fileJSON(id: "r2")])])
    await store.refreshRecent()
    check("recent: five asked for, rows shown",
          FilesStubProtocol.calls.last?.query == "limit=5" && store.recent.map(\.id) == ["r1", "r2"])

    store.reset()
    check("sign-out: every Files field is clean", store.isClean)
    return results
}

@MainActor
private func freeTimeStoreChecks() async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let body = #"{"slots":[{"startTime":"2026-10-15T02:00:00.000Z","endTime":"2026-10-15T02:30:00.000Z"}],"checkedMembers":[],"unknownMembers":["b@x.example"],"timeZone":"Asia/Seoul"}"#
    FilesStubProtocol.reset(["/api/teams/t1/availability": FilesScenarios.ok(body)])
    let store = FreeTimeStore(api: FilesScenarios.api())
    let teams = [TeamWire(id: "t1", name: "Core", members: ["b@x.example"]),
                 TeamWire(id: "t2", name: "Ops", members: [])]
    check("the first saved team is picked until the user picks another",
          store.teamId(in: teams) == "t1" && store.teamId(in: []) == nil)
    await store.find(teamId: "t1")
    let call = FilesStubProtocol.calls.last
    check("find: GET only, the 7-day 30-minute window, and the answer is kept",
          call?.path == "/api/teams/t1/availability"
          && call?.query.contains("duration_minutes=30") == true
          && store.result(for: "t1").map(FreeTimeRules.scope) == .selfOnly && store.fetchedAt != nil
          && !store.failed(for: "t1"))
    // The picked team is deleted elsewhere: the selection falls back to
    // another team, and t1's answer must not show under it.
    check("an answer is shown only under the team it was asked for",
          store.result(for: "t2") == nil
          && store.teamId(in: [TeamWire(id: "t3", name: "Other", members: [])]) == "t3"
          && store.result(for: store.teamId(in: [TeamWire(id: "t3", name: "Other", members: [])])) == nil)
    store.select(teamId: "t2")
    check("another team clears the last team's answer",
          store.result(for: "t1") == nil && store.result(for: "t2") == nil && store.teamId(in: teams) == "t2")
    FilesStubProtocol.reset([:])
    await store.find(teamId: "t2")
    check("a failed check says so and shows no slots",
          store.failed(for: "t2") && !store.failed(for: "t1") && store.result(for: "t2") == nil)
    store.reset()
    check("sign-out: free time is clean", store.isClean)
    return results
}

@MainActor
private func filesModelChecks() async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    FilesStubProtocol.reset(["/api/auth/me": FilesScenarios.ok(#"{"user":{"id":"u","files":true,"teamMode":false}}"#)])
    let model = AppModel(tokenStore: InMemoryTokenStore(), api: FilesScenarios.api())
    check("the model starts with both flags off", model.clientFlags == ClientFlags())
    await model.refreshClientFlags()
    check("the flags are read from /me", model.clientFlags == ClientFlags(files: true, teamMode: false))
    FilesStubProtocol.reset(["/api/auth/me": FilesScenarios.ok(#"{"user":{"files":false}}"#)])
    await model.refreshClientFlags()
    check("/me is not re-read inside the interval", model.clientFlags.files)
    model.mainNav.section = .files
    model.applyClientFlags(ClientFlags())
    check("Files switched off while open: the window goes to Today",
          model.mainNav.section == .today && model.files.isClean)
    return results
}

// MARK: Strings

@MainActor
private func filesStringChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    func table(_ code: String) -> [String: String] {
        guard let path = Bundle.module.path(forResource: code, ofType: "lproj"),
              let url = Bundle(path: path)?.url(forResource: "Localizable", withExtension: "strings"),
              let dict = NSDictionary(contentsOf: url) as? [String: String]
        else { return [:] }
        return dict
    }
    func specifiers(_ text: String) -> [String] {
        text.matches(of: /%(?:\d+\$)?[@dDuUxXoOfeEgGcCsSpaA]/).map { String($0.output) }
    }
    let english = table("en")
    let keys = english.keys.filter {
        $0.hasPrefix("files.") || $0.hasPrefix("today.files.") || $0.hasPrefix("today.freeTime.")
            || $0 == "nav.files"
    }
    check("the P12 catalogue has its keys", keys.count == 39)
    check("the day count is an integer format, never %@ (a past SIGSEGV)",
          specifiers(english["today.freeTime.none"] ?? "") == ["%d"])
    for code in L10n.shipped where code != "en" {
        let other = table(code)
        let drift = keys.filter { specifiers(english[$0] ?? "") != specifiers(other[$0] ?? "") }.sorted()
        check("\(code): every P12 key has English's format specifiers", drift.isEmpty)
        if !drift.isEmpty { print("      drift: \(drift.joined(separator: ", "))") }
    }
    check("integer and string formats render",
          L("today.freeTime.none", FreeTimeRules.windowDays).contains("7")
          && !L("today.freeTime.none", 7).contains("%")
          && [L("files.openFolder", "x"), L("files.download.label", "x"), L("files.download.error", "x"),
              L("files.download.gone", "x"), L("today.freeTime.unknown", "x")]
              .allSatisfy { $0.contains("x") && !$0.contains("%") })
    return results
}

/// Source pins: the free-time finder never books; the Files code never
/// writes to the drive.
@MainActor
private func filesSourcePins(sourceDir: URL) -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    let freeTime = text("FreeTimeStore.swift") + text("TodayFilesPanels.swift")
    check("free time creates no event (no POST, no booking call)",
          !freeTime.isEmpty && !freeTime.contains("api.post") && !freeTime.contains("bookTeamMeeting"))
    let drive = text("FilesStore.swift") + text("FilesSection.swift") + text("FileRowView.swift")
    check("Files is read-only (no POST, PATCH, PUT or DELETE)",
          !drive.isEmpty && !["api.post", "api.patch", "api.put", "api.delete", "method: \"DELETE\""]
              .contains(where: drive.contains))
    check("every opener goes through the validated URL",
          text("FilesStore.swift").components(separatedBy: "openURL(").count == 3)
    return results
}

// MARK: Races (stubbed network with delays)

@MainActor
private func filesRaceChecks() async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    typealias S = FilesScenarios
    let listPath = "/api/drive/files"
    func slow(_ reply: FilesStubProtocol.Reply, _ ms: Int = 300) -> FilesStubProtocol.Reply {
        var delayed = reply
        delayed.delayMs = ms
        return delayed
    }

    // A list answer that arrives after sign-out writes nothing.
    FilesStubProtocol.reset([listPath: slow(S.page([S.fileJSON(id: "late")]))])
    let store = FilesStore(api: S.api())
    let pending = Task { await store.search("") }
    try? await Task.sleep(for: .milliseconds(50))
    store.reset()
    await pending.value
    check("a list answer after sign-out is dropped", store.isClean)

    // A next page superseded by a new search must not wedge the pager.
    FilesStubProtocol.reset([listPath: S.page([S.fileJSON(id: "a")], next: "c2")])
    await store.search("")
    FilesStubProtocol.reset([
        "\(listPath)?limit=50&cursor=c2": slow(S.page([S.fileJSON(id: "old")])),
        "\(listPath)?limit=50&q=new": S.page([S.fileJSON(id: "n1")], next: "n2"),
    ])
    let more = Task { await store.loadMore() }
    try? await Task.sleep(for: .milliseconds(50))
    await store.search("new")
    await more.value
    check("a next page superseded by a search: no stale rows, the pager works again",
          store.files.map(\.id) == ["n1"] && !store.loadingMore && store.hasMore)

    // The view goes away mid-search: the cancelled request is no error.
    FilesStubProtocol.reset([listPath: S.page([S.fileJSON(id: "kept")])])
    await store.search("")
    FilesStubProtocol.reset([listPath: slow(S.page([S.fileJSON(id: "never")]), 2000)])
    let cancelled = Task { await store.search("budget") }
    try? await Task.sleep(for: .milliseconds(50))
    cancelled.cancel()
    await cancelled.value
    check("a cancelled search shows no error and keeps the list it had",
          store.phase == .loaded && store.files.map(\.id) == ["kept"] && !store.stale
          && store.appliedQuery.isEmpty)
    // The same search asked again does run (it was not marked as answered).
    FilesStubProtocol.reset([listPath: S.page([S.fileJSON(id: "b1")])])
    await store.search("budget")
    check("after a cancelled search the same search runs again", store.files.map(\.id) == ["b1"])

    // A download link that arrives after sign-out opens nothing.
    var opened: [URL] = []
    store.openURL = { opened.append($0); return true }
    FilesStubProtocol.reset([
        "/api/drive/files/f1/download": slow(S.ok(#"{"url":"https://store.example/o","expiresInSeconds":300}"#)),
    ])
    let download = Task { await store.download(S.file(id: "f1")) }
    try? await Task.sleep(for: .milliseconds(50))
    store.reset()
    await download.value
    check("a download answer after sign-out opens nothing", opened.isEmpty && store.isClean)

    // Today hands over a folder: a previous download error does not follow.
    store.seedForRender(files: [], downloadError: (.gone, "x"))
    store.startAt(folder: S.file(id: "d9", folder: true))
    check("opening Files at a folder clears the last download error",
          store.downloadError == nil && store.trail.map(\.id) == ["d9"] && !store.loadingMore)

    // Flags off: the poll asks for no drive rows and no availability.
    FilesStubProtocol.reset(["/api/auth/me": S.ok(#"{"user":{"files":false,"teamMode":false}}"#)])
    let model = AppModel(tokenStore: InMemoryTokenStore(token: "t"), api: S.api())
    model.opensRealtime = false
    await model.loadQueue()
    try? await Task.sleep(for: .milliseconds(400))
    let paths = FilesStubProtocol.calls.map(\.path)
    check("flags off: the poll reads /me and asks for no files and no free time",
          paths.contains("/api/auth/me")
          && !paths.contains { $0.hasPrefix("/api/drive/files") || $0.hasSuffix("/availability") })
    model.signOut()
    return results
}

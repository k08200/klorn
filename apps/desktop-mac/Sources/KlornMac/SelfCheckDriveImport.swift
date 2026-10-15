import Foundation
import os

// Self-check for step D7 (import picked files into the Klorn drive), run by
// `KlornMac --self-check`. Pure checks of the limits, the walk, the size
// pre-check, the error mapping, the backoff and the multipart framing, then
// scenarios that drive the real DriveImporter over real temporary files and a
// stubbed network (URLProtocol), recording every request and body it sends. No
// panel is shown and no Keychain is read: the scenarios pass their own token and
// call `importItems` with the files they made.

/// Every D7 check, as (name, passed).
func driveImportSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results = await DriveImportPureChecks.run(sourceDir: sourceDir)
    results += await DriveImportScenarios.run()
    return results.map { ("drive import — \($0.0)", $0.1) }
}

// MARK: Pure

/// A file system in memory: a path is a file (with a size), a folder, or something else.
/// What a fake source was asked: entries looked at, and children handed out.
final class FakeDriveImportSourceLog: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: (entries: 0, yielded: 0))
    var entries: Int { state.withLock { $0.entries } }
    var yielded: Int { state.withLock { $0.yielded } }
    func entry() -> Int { state.withLock { $0.entries += 1; return $0.entries } }
    func yield() { state.withLock { $0.yielded += 1 } }
}

struct FakeDriveImportFileSource: DriveImportFileSource {
    enum Node: Sendable { case file(Int64?), folder, unsupported, unreadable, unreadableFolder }
    let nodes: [String: Node]
    let log = FakeDriveImportSourceLog()
    /// Sets the flag once this many entries were looked at (a Cancel mid-walk).
    var cancelAfter: (flag: DriveImportCancelFlag, entries: Int)?

    init(nodes: [String: Node], cancelAfter: (flag: DriveImportCancelFlag, entries: Int)? = nil) {
        self.nodes = nodes
        self.cancelAfter = cancelAfter
    }

    func entry(at url: URL) -> DriveImportEntry? {
        let count = log.entry()
        if let cancelAfter, count >= cancelAfter.entries { cancelAfter.flag.cancel() }
        let name = url.lastPathComponent
        if let original = LocalDriveImportFileSource.placeholderName(name) {
            return DriveImportEntry(kind: .placeholder(name: original), name: original, isHidden: false)
        }
        let hidden = name.hasPrefix(".")
        switch nodes[url.path] {
        case .file(let size): return DriveImportEntry(kind: .file(size: size), name: name, isHidden: hidden)
        case .folder, .unreadableFolder: return DriveImportEntry(kind: .folder, name: name, isHidden: hidden)
        case .unsupported: return DriveImportEntry(kind: .unsupported, name: name, isHidden: hidden)
        case .unreadable, nil: return nil
        }
    }

    private func children(of url: URL) -> [URL]? {
        if case .unreadableFolder = nodes[url.path] { return nil }
        let prefix = url.path + "/"
        return nodes.keys
            .filter { $0.hasPrefix(prefix) && !$0.dropFirst(prefix.count).contains("/") }
            .sorted()
            .map { URL(fileURLWithPath: $0) }
    }

    /// In name order, one at a time, counting each one handed out.
    func forEachChild(of url: URL, _ body: (URL) -> Bool) -> Bool {
        guard let all = children(of: url) else { return false }
        for child in all {
            log.yield()
            if !body(child) { break }
        }
        return true
    }
}

@MainActor
private enum DriveImportPureChecks {
    static func u(_ path: String) -> URL { URL(fileURLWithPath: path) }

    // swiftlint:disable:next function_body_length
    static func run(sourceDir: URL) -> [(String, Bool)] {
        var results: [(String, Bool)] = []
        func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }
        let repo = sourceDir.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        func server(_ path: String) -> String {
            (try? String(contentsOf: repo.appendingPathComponent(path), encoding: .utf8)) ?? ""
        }

        // Limits: named, sane, and the size cap is D3's.
        check("the file cap is D3's 25 MiB", DriveImportLimits.maxFileBytes == 26_214_400
              && server("packages/api/src/storage/limits.ts")
                  .contains("export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;")
              && server("packages/api/src/drive/klorn-upload.ts")
                  .contains("export const KLORN_DRIVE_MAX_FILE_BYTES = MAX_OBJECT_BYTES;"))
        check("one import is bounded: 200 files, 50 folders, 8 levels, 1 GiB, 2 at once",
              DriveImportLimits.maxFiles == 200 && DriveImportLimits.maxFolders == 50
              && DriveImportLimits.maxFolderDepth == 8 && DriveImportLimits.maxTotalBytes == 1 << 30
              && DriveImportLimits.uploadConcurrency == 2)
        check("server: the limits probe sits behind the drive's dark gate",
              server("packages/api/src/routes/klorn-drive.ts")
                  .contains(#"app.get("/limits", guarded("limits", KLORN_LIMITS_RATE_LIMIT), limitsHandler);"#)
              && server("packages/api/src/routes/klorn-drive.ts")
                  .contains(#"app.addHook("onRequest", darkRouteGate(opts.gate));"#))

        // Every code the Mac maps is one D3 answers, with the status the Mac expects.
        let errors = server("packages/api/src/drive/klorn-errors.ts")
        let pinned: [(String, Int, DriveImportFailure)] = [
            (DriveImportRules.quotaNotConfiguredCode, 503, .quotaNotConfigured),
            (DriveImportRules.quotaExceededCode, 413, .quotaExceeded),
            (DriveImportRules.accountPurgingCode, 409, .accountPurging),
            (DriveImportRules.tooLargeCode, 413, .tooLarge),
            (DriveImportRules.rateLimitedCode, 429, .rateLimited),
            (DriveImportRules.malformedCode, 400, .malformed),
            (DriveImportRules.invalidUploadCode, 400, .malformed),
            (DriveImportRules.invalidNameCode, 400, .invalidName),
            (DriveImportRules.parentNotFoundCode, 404, .folderMissing),
            (DriveImportRules.storageUnavailableCode, 503, .storageUnavailable),
        ]
        check("every mapped code is in klorn-errors.ts with its status",
              !errors.isEmpty && pinned.allSatisfy { code, status, _ in
                  errors.contains("\"\(code)\": \(status),") || errors.contains("\(code): \(status),")
              })
        check("each D3 code maps to its own failure", pinned.allSatisfy { code, status, failure in
            DriveImportRules.failure(status: status, code: code) == failure
        })
        check("the dark gate's bare 404 means the drive is off",
              DriveImportRules.failure(status: 404, code: nil) == .featureOff)
        check("a 404 with a drive code is not the gate",
              DriveImportRules.failure(status: 404, code: "not-found") == .generic
              && DriveImportRules.failure(status: 404, code: "parent-not-found") == .folderMissing)
        check("status-only answers: 401, 413, 429, 500",
              DriveImportRules.failure(status: 401, code: nil) == .unauthorized
              && DriveImportRules.failure(status: 413, code: nil) == .tooLarge
              && DriveImportRules.failure(status: 429, code: nil) == .rateLimited
              && DriveImportRules.failure(status: 500, code: nil) == .generic
              && DriveImportRules.failure(status: 503, code: nil) == .generic)
        check("refusals every file would meet stop the import; the rest are per file",
              [DriveImportFailure.featureOff, .unauthorized, .quotaNotConfigured, .quotaExceeded, .accountPurging]
                  .allSatisfy(DriveImportRules.stopsImport)
              && [DriveImportFailure.tooLarge, .rateLimited, .malformed, .notDownloaded, .generic, .offline]
                  .allSatisfy { !DriveImportRules.stopsImport($0) })
        check("only a rate limit, storage and no answer are retried",
              [DriveImportFailure.rateLimited, .storageUnavailable, .offline].allSatisfy(DriveImportRules.isRetryable)
              && [DriveImportFailure.tooLarge, .malformed, .quotaExceeded, .generic, .featureOff]
                  .allSatisfy { !DriveImportRules.isRetryable($0) })
        let everyFailure: [DriveImportFailure] = [
            .featureOff, .unauthorized, .quotaNotConfigured, .quotaExceeded, .accountPurging, .tooLarge,
            .rateLimited, .malformed, .invalidName, .folderMissing, .storageUnavailable, .offline,
            .notDownloaded, .unreadable, .changedWhileReading, .unsupported, .cancelled, .generic,
        ]
        let english = L10n.keys(forLanguage: "en")
        check("every failure has its own localized text",
              Set(everyFailure.map(DriveImportRules.messageKey)).count == everyFailure.count
              && everyFailure.allSatisfy { english.contains(DriveImportRules.messageKey($0)) })
        check("the too-large text names the cap in MB",
              DriveImportRules.message(.tooLarge, maxFileBytes: DriveImportLimits.maxFileBytes).contains("25"))

        // Backoff.
        check("backoff doubles from 2 s and stops at 60 s",
              (1...7).map { DriveImportRules.backoffSeconds(attempt: $0, retryAfter: nil) }
                  == [2, 4, 8, 16, 32, 60, 60])
        check("backoff follows Retry-After, within 1 to 60 s",
              DriveImportRules.backoffSeconds(attempt: 1, retryAfter: 30) == 30
              && DriveImportRules.backoffSeconds(attempt: 3, retryAfter: 0) == 1
              && DriveImportRules.backoffSeconds(attempt: 1, retryAfter: 600) == 60)
        check("Retry-After is read as whole seconds only",
              DriveImportRules.retryAfterSeconds("17") == 17 && DriveImportRules.retryAfterSeconds(" 5 ") == 5
              && DriveImportRules.retryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT") == nil
              && DriveImportRules.retryAfterSeconds("-3") == nil && DriveImportRules.retryAfterSeconds(nil) == nil)

        // Size pre-check.
        let cap = DriveImportLimits.maxFileBytes
        check("size pre-check: empty and exactly the cap go, one byte over does not",
              DriveImportRules.sizeVerdict(0, maxFileBytes: cap) == nil
              && DriveImportRules.sizeVerdict(cap, maxFileBytes: cap) == nil
              && DriveImportRules.sizeVerdict(cap + 1, maxFileBytes: cap) == .tooLarge)
        check("size pre-check: no size, or a negative one, is unreadable",
              DriveImportRules.sizeVerdict(nil, maxFileBytes: cap) == .unreadable
              && DriveImportRules.sizeVerdict(-1, maxFileBytes: cap) == .unreadable)

        results += walkChecks()
        results += multipartChecks()
        results += gateAndMenuChecks()
        results += formatChecks()
        results += sourceChecks(sourceDir: sourceDir)
        return results
    }

    static func walkChecks() -> [(String, Bool)] {
        var results: [(String, Bool)] = []
        func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }
        let source = FakeDriveImportFileSource(nodes: [
            "/p/loose.pdf": .file(10),
            "/p/Docs": .folder,
            "/p/Docs/a.txt": .file(1),
            "/p/Docs/.DS_Store": .file(1),
            "/p/Docs/link": .unsupported,
            "/p/Docs/big.mov": .file(DriveImportLimits.maxFileBytes + 1),
            "/p/Docs/.cloud.pdf.icloud": .file(0),
            "/p/Docs/Sub": .folder,
            "/p/Docs/Sub/b.txt": .file(2),
            "/p/.hidden-picked": .file(3),
        ])
        let plan = DriveImportWalk.plan(
            picked: [u("/p/loose.pdf"), u("/p/Docs"), u("/p/.hidden-picked")], source: source)
        check("walk: a picked file, a picked folder and its folder, in order",
              plan.folders == [.init(id: 0, name: "Docs", parent: nil), .init(id: 1, name: "Sub", parent: 0)]
              && plan.files.map(\.name) == ["loose.pdf", "b.txt", "a.txt", ".hidden-picked"]
              && plan.files.map(\.folder) == [nil, 1, 0, nil])
        check("walk: hidden files inside a folder are left out silently; one picked by name goes",
              !plan.files.contains { $0.name == ".DS_Store" } && !plan.skipped.contains { $0.name == ".DS_Store" }
              && plan.files.contains { $0.name == ".hidden-picked" })
        check("walk: a link is never followed, and is reported",
              plan.skipped.contains(.init(name: "link", reason: .unsupported)))
        check("walk: a file over the cap is reported and counts toward nothing",
              plan.skipped.contains(.init(name: "big.mov", reason: .tooLarge)) && plan.totalBytes == 16)
        check("walk: an old iCloud placeholder is reported as not downloaded, by its real name",
              plan.skipped.contains(.init(name: "cloud.pdf", reason: .notDownloaded))
              && LocalDriveImportFileSource.placeholderName(".Report.pdf.icloud") == "Report.pdf"
              && LocalDriveImportFileSource.placeholderName("Report.pdf") == nil
              && LocalDriveImportFileSource.placeholderName(".icloud") == nil)
        check("walk: no cap reached", plan.caps.isEmpty)

        var deep: [String: FakeDriveImportFileSource.Node] = [:]
        var path = "/d"
        for level in 0..<6 {
            deep[path] = .folder
            deep[path + "/f\(level).txt"] = .file(1)
            path += "/L\(level + 1)"
        }
        var depthLimits = DriveImportWalkLimits()
        depthLimits.maxDepth = 2
        let depthPlan = DriveImportWalk.plan(
            picked: [u("/d")], source: FakeDriveImportFileSource(nodes: deep), limits: depthLimits)
        check("walk: folders past the depth cap are left out, and the cap is reported",
              depthPlan.folders.count == 3 && depthPlan.files.count == 3 && depthPlan.caps == [.depth])

        var countLimits = DriveImportWalkLimits()
        countLimits.maxFiles = 3
        let many = FakeDriveImportFileSource(nodes: [
            "/m": .folder, "/m/1": .file(1), "/m/2": .file(1), "/m/3": .file(1), "/m/4": .file(1),
            "/later.txt": .file(1),
        ])
        let countPlan = DriveImportWalk.plan(picked: [u("/m"), u("/later.txt")], source: many, limits: countLimits)
        check("walk: the file cap stops the whole walk, later picks included",
              countPlan.files.map(\.name) == ["1", "2", "3"] && countPlan.caps == [.files])

        var byteLimits = DriveImportWalkLimits()
        byteLimits.maxTotalBytes = 10
        let heavy = FakeDriveImportFileSource(nodes: ["/a": .file(4), "/b": .file(4), "/c": .file(4)])
        let bytePlan = DriveImportWalk.plan(picked: [u("/a"), u("/b"), u("/c")], source: heavy, limits: byteLimits)
        check("walk: the byte cap stops before the file that would pass it",
              bytePlan.files.map(\.name) == ["a", "b"] && bytePlan.totalBytes == 8 && bytePlan.caps == [.bytes])

        var folderLimits = DriveImportWalkLimits()
        folderLimits.maxFolders = 2
        let wide = FakeDriveImportFileSource(nodes: [
            "/w": .folder, "/w/x": .folder, "/w/y": .folder, "/w/y/in.txt": .file(1),
        ])
        let folderPlan = DriveImportWalk.plan(picked: [u("/w")], source: wide, limits: folderLimits)
        check("walk: the folder cap leaves the next folder (and what is in it) out",
              folderPlan.folders.map(\.name) == ["w", "x"] && folderPlan.files.isEmpty
              && folderPlan.caps == [.folders])

        let flag = DriveImportCancelFlag()
        var twenty: [String: FakeDriveImportFileSource.Node] = ["/c": .folder]
        for index in 0..<20 { twenty["/c/f" + String(format: "%02d", index)] = .file(1) }
        let cancelling = FakeDriveImportFileSource(nodes: twenty, cancelAfter: (flag, 5))
        let cancelledPlan = DriveImportWalk.plan(picked: [u("/c"), u("/c/f19")], source: cancelling, cancel: flag)
        check("walk: a cancel stops it before the next entry, later picks included",
              cancelledPlan.cancelled && cancelling.log.entries == 5 && cancelledPlan.files.count == 4)
        let notCancelled = DriveImportWalk.plan(
            picked: [u("/c")], source: FakeDriveImportFileSource(nodes: twenty), cancel: DriveImportCancelFlag())
        check("walk: an untouched flag changes nothing", !notCancelled.cancelled && notCancelled.files.count == 20)

        var crowd: [String: FakeDriveImportFileSource.Node] = ["/h": .folder, "/h/z.txt": .file(1)]
        for index in 0..<30 { crowd["/h/.h" + String(format: "%02d", index)] = .file(1) }
        var examinedLimits = DriveImportWalkLimits()
        examinedLimits.maxExamined = 10
        let crowdSource = FakeDriveImportFileSource(nodes: crowd)
        let crowdPlan = DriveImportWalk.plan(picked: [u("/h")], source: crowdSource, limits: examinedLimits)
        check("walk: every entry looked at counts (hidden ones too); the examined cap stops the walk",
              crowdPlan.caps == [.examined] && crowdPlan.files.isEmpty && crowdSource.log.entries == 10)
        check("walk: a folder is read one entry at a time, never past the stop",
              crowdSource.log.yielded > 0 && crowdSource.log.yielded <= 10)
        check("walk: the examined cap is 10,000 by default",
              DriveImportLimits.maxEntriesExamined == 10_000 && DriveImportWalkLimits().maxExamined == 10_000)

        let broken = FakeDriveImportFileSource(nodes: ["/q": .unreadableFolder, "/r": .unreadable])
        let brokenPlan = DriveImportWalk.plan(picked: [u("/q"), u("/r")], source: broken)
        check("walk: an unreadable folder or file is reported, not created",
              brokenPlan.folders.isEmpty
              && brokenPlan.skipped == [.init(name: "q", reason: .unreadable), .init(name: "r", reason: .unreadable)])
        return results
    }

    static func multipartChecks() -> [(String, Bool)] {
        var results: [(String, Bool)] = []
        func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }
        let head = String(decoding: DriveMultipart.head(
            boundary: "B", size: 42, parentExternalId: nil, fileName: "a.pdf"), as: UTF8.self)
        check("multipart: size, then the file part, exactly as D3 reads them",
              head == "--B\r\nContent-Disposition: form-data; name=\"size\"\r\n\r\n42\r\n"
                + "--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.pdf\"\r\n"
                + "Content-Type: application/octet-stream\r\n\r\n")
        let withParent = String(decoding: DriveMultipart.head(
            boundary: "B", size: 0, parentExternalId: "ext-1", fileName: "a"), as: UTF8.self)
        check("multipart: the parent field sits between size and the file",
              withParent.contains("name=\"size\"\r\n\r\n0\r\n--B\r\nContent-Disposition: form-data; name=\"parentExternalId\"\r\n\r\next-1\r\n--B\r\nContent-Disposition: form-data; name=\"file\""))
        check("multipart: the closing boundary",
              DriveMultipart.tail(boundary: "B") == Data("\r\n--B--\r\n".utf8))
        check("multipart: a quote is escaped, a line break dropped",
              DriveMultipart.quotedFileName("say \"hi\"\r\n.txt") == "say \\\"hi\\\".txt")
        check("multipart: slashes are replaced (the parser keeps only what follows the last)",
              DriveMultipart.quotedFileName("a\\b/c.txt") == "a_b_c.txt")
        check("multipart: Korean and other UTF-8 names are kept as they are",
              DriveMultipart.quotedFileName("회의록 2026.hwp") == "회의록 2026.hwp")
        check("multipart: a name with nothing left gets a fallback",
              DriveMultipart.quotedFileName("\u{7}\n") == DriveMultipart.fallbackFileName)
        check("multipart: the content type names the boundary",
              DriveMultipart.contentType(boundary: "B") == "multipart/form-data; boundary=B"
              && DriveMultipart.makeBoundary() != DriveMultipart.makeBoundary())
        return results
    }

    static func gateAndMenuChecks() -> [(String, Bool)] {
        var results: [(String, Bool)] = []
        func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }
        let wire = DriveLimitsWire(maxFileBytes: 10, quotaBytes: 100, usedBytes: 0)
        check("404 hides: the dark gate's answer hides a section that was shown",
              DriveImporter.availability(after: .failure(.featureOff), current: .available) == .unavailable)
        check("an answer shows it; no answer leaves it as it was; a lost session forgets it",
              DriveImporter.availability(after: .success(wire), current: .unavailable) == .available
              && DriveImporter.availability(after: .failure(.offline), current: .available) == .available
              && DriveImporter.availability(after: .failure(.offline), current: .unknown) == .unknown
              && DriveImporter.availability(after: .failure(.unauthorized), current: .available) == .unknown)
        check("no quota on the server refuses the import before anything is read",
              DriveImporter.refusalBeforeImport(.success(DriveLimitsWire(maxFileBytes: 10, quotaBytes: nil, usedBytes: 0)))
                  == .quotaNotConfigured
              && DriveImporter.refusalBeforeImport(.success(wire)) == nil
              && DriveImporter.refusalBeforeImport(.failure(.featureOff)) == .featureOff)
        check("Settings: Klorn Drive is in Accounts, after device calendars, and needs a sign-in",
              SettingsTab.accounts.sections == [.account, .inboxes, .deviceCalendars, .driveImport]
              && PrefsSection.driveImport.requiresSignIn)
        let ready = MenuState(
            signedIn: true, fullViewOpen: false, mailSurfaceIsKey: false, modalOpen: false, targetTier: nil,
            emailLoaded: false, readerReplying: false, teamModeAvailable: false, listHasSearchField: true,
            driveImportReady: true)
        var notReady = ready
        notReady.driveImportReady = false
        var signedOut = ready
        signedOut.signedIn = false
        var modal = ready
        modal.modalOpen = true
        check("menu: Import is live only when the drive is ready, signed in, with no modal",
              MenuRules.isEnabled(.importToDrive, in: ready)
              && !MenuRules.isEnabled(.importToDrive, in: notReady)
              && !MenuRules.isEnabled(.importToDrive, in: signedOut)
              && !MenuRules.isEnabled(.importToDrive, in: modal))
        check("menu: Import has no key equivalent to collide with", MenuRules.shortcut(for: .importToDrive) == nil)
        check("menu: the title is localized", L("menu.importToDrive") != "menu.importToDrive")
        check("every cap has its own localized line",
              Set(DriveImportCap.allCases.map(DriveImportSection.capLine)).count == DriveImportCap.allCases.count
              && DriveImportCap.allCases.allSatisfy { !DriveImportSection.capLine($0).hasPrefix("driveImport.") })
        let report = DriveImportReport(
            uploaded: 3, notUploaded: [.init(name: "x", reason: .tooLarge)], caps: [.files, .depth],
            stoppedBy: .quotaExceeded)
        let lines = DriveImportSection.summaryLines(report, maxFileBytes: DriveImportLimits.maxFileBytes)
        check("report: count, the reason it stopped, then each cap",
              lines.count == 4 && lines[0].contains("3") && lines[1] == L("driveImport.error.full")
              && lines[2] == DriveImportSection.capLine(.files) && lines[3] == DriveImportSection.capLine(.depth))
        return results
    }

    /// Every D7 key carries the same format specifiers in every language: an
    /// "%@" where English has "%d" reads the integer as a pointer and crashes,
    /// only in that language.
    static func formatChecks() -> [(String, Bool)] {
        var results: [(String, Bool)] = []
        func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }
        func table(_ code: String) -> [String: String] {
            guard let path = Bundle.module.path(forResource: code, ofType: "lproj"),
                  let url = Bundle(path: path)?.url(forResource: "Localizable", withExtension: "strings"),
                  let dict = NSDictionary(contentsOf: url) as? [String: String]
            else { return [:] }
            return dict
        }
        func specifiers(_ text: String) -> [String] {
            let pattern = /%(?:\d+\$)?[@dDuUxXoOfeEgGcCsSpaA]/
            var found = text.matches(of: pattern).map { String($0.output) }
            // Positional ones may move; unnumbered ones keep their order.
            if found.allSatisfy({ $0.contains("$") }) { found.sort() }
            return found
        }
        let english = table("en")
        let keys = english.keys.filter {
            $0.hasPrefix("driveImport.") || $0 == "menu.importToDrive" || $0 == "prefs.section.driveImport"
        }
        check("the D7 catalogue has its keys", keys.count == 38)
        for code in L10n.shipped where code != "en" {
            let other = table(code)
            let drift = keys.filter { specifiers(english[$0] ?? "") != specifiers(other[$0] ?? "") }.sorted()
            check("\(code): every D7 key has English's format specifiers", drift.isEmpty)
            if !drift.isEmpty { print("      drift: \(drift.joined(separator: ", "))") }
        }
        check("integer and string formats render", [
            L("driveImport.progress", 2, 9), L("driveImport.summary.all", 4), L("driveImport.summary", 4, 1),
            L("driveImport.more", 5), L("driveImport.cap.files", 200), L("driveImport.cap.folders", 50),
            L("driveImport.cap.depth", 8), L("driveImport.cap.bytes", 1), L("driveImport.error.tooLarge", 25),
            L("driveImport.cap.examined", 10_000),
        ].allSatisfy { $0.contains(where: \.isNumber) && !$0.contains("%") }
            && L("driveImport.usage", "1 MB", "2 GB").contains("2 GB"))
        return results
    }

    /// Source pins: nothing is watched in the background, and the upload streams from disk.
    static func sourceChecks(sourceDir: URL) -> [(String, Bool)] {
        let drive = sourceDir.appendingPathComponent("Drive")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: drive.path)) ?? []
        let texts = names.filter { $0.hasSuffix(".swift") }.compactMap {
            try? String(contentsOf: drive.appendingPathComponent($0), encoding: .utf8)
        }
        let all = texts.joined(separator: "\n")
        let watchers = ["NSMetadataQuery", "FSEventStream", "makeFileSystemObjectSource", "addFilePresenter",
                        "NSFileCoordinator.addFilePresenter", "startDownloadingUbiquitousItem", "Timer.scheduled"]
        return [
            ("the drive code is all there", texts.count == 6),
            ("no background watching: no query, no file-system events, no presenter (P4)",
             watchers.allSatisfy { !all.contains($0) }),
            ("the upload streams its body from a file", all.contains("session.upload(for: req, fromFile: file)")),
            ("cloud files are read under a file coordinator", all.contains("coordinate(readingItemAt:")),
        ]
    }
}

// MARK: Scenarios: the real importer, real files, a stubbed network

/// Answers every request of the scenarios' URLSession from a script, and records
/// each request with its body (an upload's body arrives as a stream).
final class DriveImportStubProtocol: URLProtocol, @unchecked Sendable {
    struct Call: Sendable {
        let method: String
        let path: String
        let bearer: String?
        let contentType: String?
        let body: Data
    }
    struct Reply: Sendable {
        let status: Int
        let body: String
        var headers: [String: String] = [:]
        var delayMs = 0
    }

    /// Replies per "METHOD path", used in order; the last one repeats.
    static let state = OSAllocatedUnfairLock(initialState: (replies: [String: [Reply]](), calls: [Call]()))

    static func reset(_ replies: [String: [Reply]]) { state.withLock { $0 = (replies, []) } }
    static var calls: [Call] { state.withLock { $0.calls } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let method = request.httpMethod ?? "GET"
        let call = Call(
            method: method, path: url.path, bearer: request.value(forHTTPHeaderField: "Authorization"),
            contentType: request.value(forHTTPHeaderField: "Content-Type"), body: Self.body(of: request))
        let reply: Reply = Self.state.withLock { state in
            state.calls.append(call)
            let key = "\(method) \(url.path)"
            guard var queue = state.replies[key], let first = queue.first else {
                // Fastify's default 404, as the dark gate sends it.
                return Reply(status: 404, body: #"{"message":"Route \#(key) not found","error":"Not Found","statusCode":404}"#) // wire-value
            }
            if queue.count > 1 {
                queue.removeFirst()
                state.replies[key] = queue
            }
            return first
        }
        guard reply.delayMs > 0 else { return answer(reply, url: url) }
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(reply.delayMs)) { [self] in
            answer(reply, url: url)
        }
    }

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    private func answer(_ reply: Reply, url: URL) {
        var headers = reply.headers
        headers["Content-Type"] = "application/json"
        let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers)
        if let response { client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed) }
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Records each wait instead of waiting.
final class DriveImportSleepLog: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: [Duration]())
    var waits: [Duration] { lock.withLock { $0 } }
    func record(_ wait: Duration) { lock.withLock { $0.append(wait) } }
}

@MainActor
enum DriveImportScenarios {
    static let limitsPath = "GET /api/drive/limits"
    static let filesPath = "POST /api/drive/files"
    static let foldersPath = "POST /api/drive/folders"
    static let dark = DriveImportStubProtocol.Reply(
        status: 404, body: #"{"message":"Route GET:/api/drive/limits not found","error":"Not Found","statusCode":404}"#) // wire-value

    static func limits(maxFileBytes: Int64 = 1000, quota: String = "1000000") -> DriveImportStubProtocol.Reply {
        .init(status: 200, body: #"{"maxFileBytes":\#(maxFileBytes),"quotaBytes":\#(quota),"usedBytes":5}"#)
    }

    /// A D3 answer as main sends it since D4: `summary` and fields the Mac does not read are ignored.
    static func created(_ externalId: String) -> DriveImportStubProtocol.Reply {
        .init(status: 201, body: #"{"file":{"id":"r","externalId":"\#(externalId)","name":"n","isFolder":false,"#
            + #""summary":{"status":"PENDING","text":null,"error":null,"summarizedAt":null},"#
            + #""futureField":[1,2]}}"#)
    }

    static func refused(
        _ status: Int, _ code: String, retryable: Bool = false, headers: [String: String] = [:]
    ) -> DriveImportStubProtocol.Reply {
        .init(status: status, body: #"{"error":"x","code":"\#(code)","retryable":\#(retryable)}"#, headers: headers)
    }

    static func api() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DriveImportStubProtocol.self]
        return APIClient(base: "https://klorn.test", session: URLSession(configuration: config), token: { "tok-1" })
    }

    static func importer(_ sleeps: DriveImportSleepLog, bodies: URL) -> DriveImporter {
        DriveImporter(
            api: api(), pick: { [] }, bodyDirectory: bodies,
            sleep: { wait in sleeps.record(wait) })
    }

    /// A scratch tree of real files, removed at the end.
    static func makeTree(_ root: URL) throws -> [String: URL] {
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("Docs/Sub"), withIntermediateDirectories: true)
        var files: [String: URL] = [:]
        func write(_ relative: String, _ bytes: Data) throws {
            let url = root.appendingPathComponent(relative)
            try bytes.write(to: url)
            files[relative] = url
        }
        try write("loose.txt", Data("loose".utf8))
        try write("Docs/a.txt", Data("alpha".utf8))
        try write("Docs/Sub/b.txt", Data(repeating: 0x62, count: 300))
        try write("Docs/huge.bin", Data(repeating: 0, count: 2000))
        try write("empty.txt", Data())
        return files
    }

    /// The multipart parts of one recorded body, by field name.
    static func parts(_ call: DriveImportStubProtocol.Call) -> [String: Data] {
        guard let type = call.contentType, let range = type.range(of: "boundary=") else { return [:] }
        let boundary = Data("--\(type[range.upperBound...])".utf8)
        var result: [String: Data] = [:]
        var chunks: [Data] = []
        var rest = call.body[...]
        while let hit = rest.range(of: boundary) {
            chunks.append(Data(rest[..<hit.lowerBound]))
            rest = rest[hit.upperBound...]
        }
        for chunk in chunks {
            guard let split = chunk.range(of: Data("\r\n\r\n".utf8)) else { continue }
            let header = String(decoding: chunk[..<split.lowerBound], as: UTF8.self)
            var value = Data(chunk[split.upperBound...])
            if value.suffix(2) == Data("\r\n".utf8) { value.removeLast(2) }
            guard let name = header.firstMatch(of: /name="([^"]+)"/)?.output.1 else { continue }
            result[String(name)] = value
        }
        return result
    }

    // swiftlint:disable:next function_body_length
    static func run() async -> [(String, Bool)] {
        var results: [(String, Bool)] = []
        func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("klorn-selfcheck-drive-\(UUID().uuidString)", isDirectory: true)
        let bodies = scratch.appendingPathComponent("bodies", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let files: [String: URL]
        do { files = try makeTree(scratch.appendingPathComponent("tree")) } catch {
            return [("scratch files can be written", false)]
        }
        func file(_ name: String) -> URL { files[name] ?? scratch }
        let tree = scratch.appendingPathComponent("tree")

        // The body writer, over a real file bigger than one chunk.
        do {
            let big = scratch.appendingPathComponent("big.bin")
            let bytes = Data((0..<(DriveImportLimits.copyChunkBytes + 12_345)).map { UInt8($0 % 251) })
            try bytes.write(to: big)
            let body = try await DriveImportBodyWriter.write(
                source: big, fileName: "big.bin", parentExternalId: "p-1",
                maxFileBytes: DriveImportLimits.maxFileBytes, directory: bodies)
            let written = try Data(contentsOf: body.file)
            let expected = DriveMultipart.head(boundary: body.boundary, size: Int64(bytes.count), parentExternalId: "p-1", fileName: "big.bin")
                + bytes + DriveMultipart.tail(boundary: body.boundary)
            check("body: framing, every byte across chunks, and the exact size", written == expected
                  && body.size == Int64(bytes.count))
            try? FileManager.default.removeItem(at: body.file)
        } catch {
            check("body: framing, every byte across chunks, and the exact size", false)
        }
        do {
            _ = try await DriveImportBodyWriter.write(
                source: file("Docs/huge.bin"), fileName: "huge.bin", parentExternalId: nil, maxFileBytes: 1000,
                directory: bodies)
            check("body: a file over the cap when read is refused", false)
        } catch {
            check("body: a file over the cap when read is refused", (error as? DriveImportFailure) == .tooLarge
                  && ((try? FileManager.default.contentsOfDirectory(atPath: bodies.path)) ?? []).isEmpty)
        }
        do {
            _ = try await DriveImportBodyWriter.write(
                source: scratch.appendingPathComponent("missing.txt"), fileName: "missing.txt",
                parentExternalId: nil, maxFileBytes: 1000, directory: bodies)
            check("body: a file that cannot be read is reported as unreadable", false)
        } catch {
            check("body: a file that cannot be read is reported as unreadable",
                  (error as? DriveImportFailure) == .unreadable)
        }
        check("body: a file that shrinks or grows while read is refused", Self.changedWhileReading(scratch))

        results += await hardeningScenarios(scratch: scratch, loose: file("loose.txt"))

        // Dark server: the probe's 404 hides everything.
        let sleeps = DriveImportSleepLog()
        DriveImportStubProtocol.reset([limitsPath: [dark]])
        let off = importer(sleeps, bodies: bodies)
        await off.refreshAvailability()
        check("dark server: the probe's 404 hides the menu item and the section",
              off.availability == .unavailable && !off.canImport)

        // No quota: shown, but nothing is read or sent.
        DriveImportStubProtocol.reset([limitsPath: [limits(quota: "null")]])
        let unconfigured = importer(sleeps, bodies: bodies)
        await unconfigured.refreshAvailability()
        await unconfigured.importItems([file("loose.txt")])
        check("no quota: the section shows, the import stops before any upload",
              unconfigured.availability == .available && !unconfigured.canImport
              && unconfigured.report?.stoppedBy == .quotaNotConfigured
              && !DriveImportStubProtocol.calls.contains { $0.method == "POST" })

        // The whole path: folders first, then the files, streamed, with their parents.
        DriveImportStubProtocol.reset([
            limitsPath: [limits()],
            foldersPath: [created("f-docs"), created("f-sub")],
            filesPath: [created("x")],
        ])
        let happy = importer(sleeps, bodies: bodies)
        await happy.refreshAvailability()
        await happy.importItems([file("loose.txt"), tree.appendingPathComponent("Docs"), file("empty.txt")])
        let calls = DriveImportStubProtocol.calls
        let uploads = calls.filter { $0.method == "POST" && $0.path == "/api/drive/files" }
        let byName = Dictionary(uploads.map { call -> (String, [String: Data]) in
            let fields = parts(call)
            let disposition = String(decoding: call.body.prefix(2048), as: UTF8.self)
            let marker = "filename=\""
            let name = disposition.range(of: marker).map { range in
                String(disposition[range.upperBound...].prefix { $0 != "\"" })
            } ?? ""
            return (name, fields)
        }, uniquingKeysWith: { first, _ in first })
        let report = happy.report
        check("import: four files uploaded, the oversized one reported, two folders made",
              report?.uploaded == 4 && report?.foldersCreated == 2
              && report?.notUploaded == [.init(name: "huge.bin", reason: .tooLarge)]
              && happy.phase == .finished)
        let firstUpload = calls.firstIndex { $0.path == "/api/drive/files" } ?? 0
        let lastFolder = calls.lastIndex { $0.path == "/api/drive/folders" } ?? Int.max
        check("import: every folder exists before the first file is sent", lastFolder < firstUpload)
        let folderBodies = calls.filter { $0.path == "/api/drive/folders" }
            .map { String(decoding: $0.body, as: UTF8.self) }
        check("import: a picked folder lands at the root, its folder inside it",
              folderBodies.count == 2 && folderBodies[0].contains(#""name":"Docs""#)
              && !folderBodies[0].contains("f-docs")
              && folderBodies[1].contains(#""name":"Sub""#) && folderBodies[1].contains(#""parentExternalId":"f-docs""#))
        check("import: each file carries its exact size, its folder, and its bytes",
              byName["a.txt"]?["size"] == Data("5".utf8) && byName["a.txt"]?["parentExternalId"] == Data("f-docs".utf8)
              && byName["a.txt"]?["file"] == Data("alpha".utf8)
              && byName["b.txt"]?["parentExternalId"] == Data("f-sub".utf8)
              && byName["b.txt"]?["file"] == Data(repeating: 0x62, count: 300)
              && byName["loose.txt"]?["parentExternalId"] == nil && byName["loose.txt"]?["file"] == Data("loose".utf8)
              && byName["empty.txt"]?["size"] == Data("0".utf8))
        check("import: every request carries the session's token, never anything else",
              calls.allSatisfy { $0.bearer == "Bearer tok-1" })
        check("import: the bodies on disk are gone afterwards",
              ((try? FileManager.default.contentsOfDirectory(atPath: bodies.path)) ?? []).isEmpty)

        // Rate limited: waits as told, then succeeds.
        DriveImportStubProtocol.reset([
            limitsPath: [limits()],
            filesPath: [refused(429, "rate-limited", retryable: true, headers: ["Retry-After": "7"]), created("x")],
        ])
        let limitedSleeps = DriveImportSleepLog()
        let limited = importer(limitedSleeps, bodies: bodies)
        await limited.refreshAvailability()
        await limited.importItems([file("loose.txt")])
        check("import: a file answer carrying D4's summary (and unknown fields) still decodes",
              created("x").body.contains(#""summary":{"status":"PENDING""#) && report?.uploaded == 4)
        let limitsWithExtra = Data(#"{"maxFileBytes":1,"quotaBytes":null,"usedBytes":0,"later":true}"#.utf8)
        check("limits: an answer with a field added later still decodes",
              (try? JSONDecoder().decode(DriveLimitsWire.self, from: limitsWithExtra))?.quotaBytes == nil
              && (try? JSONDecoder().decode(DriveLimitsWire.self, from: limitsWithExtra))?.maxFileBytes == 1)

        check("rate limited: waits Retry-After, then uploads",
              limited.report?.uploaded == 1 && limitedSleeps.waits == [.seconds(7)]
              && DriveImportStubProtocol.calls.filter { $0.path == "/api/drive/files" }.count == 2)

        // Still limited after every try: reported, not looped forever.
        DriveImportStubProtocol.reset([
            limitsPath: [limits()], filesPath: [refused(429, "rate-limited", retryable: true)],
        ])
        let stuckSleeps = DriveImportSleepLog()
        let stuck = importer(stuckSleeps, bodies: bodies)
        await stuck.refreshAvailability()
        await stuck.importItems([file("loose.txt")])
        check("rate limited throughout: gives up after the last try with the reason",
              stuck.report?.notUploaded == [.init(name: "loose.txt", reason: .rateLimited)]
              && stuckSleeps.waits.count == DriveImportLimits.maxAttempts - 1
              && DriveImportStubProtocol.calls.filter { $0.path == "/api/drive/files" }.count
                  == DriveImportLimits.maxAttempts)

        // A refusal every file would meet stops the rest.
        DriveImportStubProtocol.reset([limitsPath: [limits()], filesPath: [refused(413, "quota-exceeded")]])
        let full = importer(sleeps, bodies: bodies)
        await full.refreshAvailability()
        await full.importItems([file("loose.txt"), file("Docs/a.txt"), file("Docs/Sub/b.txt"), file("empty.txt")])
        let fullSends = DriveImportStubProtocol.calls.filter { $0.path == "/api/drive/files" }.count
        check("drive full: the import stops, the rest are reported with the reason",
              full.report?.stoppedBy == .quotaExceeded && full.report?.uploaded == 0
              && full.report?.notUploaded.count == 4
              && full.report?.notUploaded.allSatisfy { $0.reason == .quotaExceeded } == true
              && fullSends <= DriveImportLimits.uploadConcurrency)

        // Purging and a malformed body.
        DriveImportStubProtocol.reset([
            limitsPath: [limits()], filesPath: [refused(400, "multipart-malformed"), refused(409, "account-purging")],
        ])
        let mixed = importer(sleeps, bodies: bodies)
        await mixed.refreshAvailability()
        await mixed.importItems([file("loose.txt"), file("Docs/a.txt"), file("Docs/Sub/b.txt")])
        let reasons = Set(mixed.report?.notUploaded.map(\.reason) ?? [])
        check("a malformed upload is per file; a pending purge stops the import",
              reasons.contains(.malformed) && mixed.report?.stoppedBy == .accountPurging
              && reasons.isSubset(of: [.malformed, .accountPurging]))

        // The server goes dark mid-import: the feature hides.
        DriveImportStubProtocol.reset([limitsPath: [limits()]])
        let flipped = importer(sleeps, bodies: bodies)
        await flipped.refreshAvailability()
        await flipped.importItems([file("loose.txt")])
        check("dark mid-import: the 404 stops it and hides the feature",
              flipped.report?.stoppedBy == .featureOff && flipped.availability == .unavailable)

        // Cancel: the upload in flight ends, nothing more is sent.
        var slow = created("x")
        slow.delayMs = 3000
        DriveImportStubProtocol.reset([limitsPath: [limits()], filesPath: [slow]])
        let cancelling = importer(sleeps, bodies: bodies)
        await cancelling.refreshAvailability()
        let running = Task { await cancelling.importItems([file("loose.txt"), file("Docs/a.txt"), file("empty.txt")]) }
        try? await Task.sleep(for: .milliseconds(300))
        let wasRunning = cancelling.isRunning
        cancelling.cancel()
        await running.value
        check("cancel: the import ends as cancelled, nothing uploaded",
              wasRunning && cancelling.report?.cancelled == true && cancelling.report?.uploaded == 0
              && cancelling.report?.notUploaded.count == 3)

        // Sign-out: the report and the availability belong to the account that left.
        DriveImportStubProtocol.reset([limitsPath: [limits()], filesPath: [created("x")]])
        let leaving = importer(sleeps, bodies: bodies)
        await leaving.refreshAvailability()
        await leaving.importItems([file("loose.txt")])
        leaving.signOut()
        check("sign-out: no report, no limits, availability unknown",
              leaving.report == nil && leaving.limits == nil && leaving.availability == .unknown
              && leaving.phase == .idle)
        return results
    }

    static func permissions(_ url: URL) -> Int? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions] as? Int
    }

    static func isEmptyOrMissing(_ directory: URL) -> Bool {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).isEmpty
    }

    /// The review fixes: odd file types, private bodies, the launch sweep, cancel before
    /// any read, the server's `retryable`, and progress after a sign-out.
    // swiftlint:disable:next function_body_length
    static func hardeningScenarios(scratch: URL, loose: URL) async -> [(String, Bool)] {
        var results: [(String, Bool)] = []
        func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }
        let fm = FileManager.default

        // A folder holding a link, a Finder alias and a pipe, next to one real file.
        let odd = scratch.appendingPathComponent("odd", isDirectory: true)
        let real = odd.appendingPathComponent("real.txt")
        do {
            try fm.createDirectory(at: odd, withIntermediateDirectories: true)
            try Data("real".utf8).write(to: real)
            try fm.createSymbolicLink(at: odd.appendingPathComponent("link"), withDestinationURL: real)
            let bookmark = try real.bookmarkData(
                options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
            try URL.writeBookmarkData(bookmark, to: odd.appendingPathComponent("alias"))
            _ = mkfifo(odd.appendingPathComponent("pipe").path, 0o600)
            let plan = DriveImportWalk.plan(picked: [odd], source: LocalDriveImportFileSource())
            let unsupported = Set(plan.skipped.filter { $0.reason == .unsupported }.map(\.name))
            check("real files: a link, a Finder alias and a pipe are skipped, never read",
                  plan.files.map(\.name) == ["real.txt"] && unsupported == ["link", "alias", "pipe"])
        } catch {
            check("real files: a link, a Finder alias and a pipe are skipped, never read", false)
        }

        // Bodies: private, in the app's Caches folder.
        let private_ = scratch.appendingPathComponent("private/bodies", isDirectory: true)
        do {
            let body = try await DriveImportBodyWriter.write(
                source: loose, fileName: "loose.txt", parentExternalId: nil, maxFileBytes: 1000, directory: private_)
            check("bodies: the folder is 0700 and each body 0600",
                  permissions(private_) == 0o700 && permissions(body.file) == 0o600)
            try? fm.removeItem(at: body.file)
        } catch {
            check("bodies: the folder is 0700 and each body 0600", false)
        }
        check("bodies live in the app's Caches folder, not bare $TMPDIR",
              DriveImportBodyWriter.directory.path.hasSuffix("/Library/Caches/ai.klorn.desktop/drive-import"))

        // The launch sweep.
        let sweepDir = scratch.appendingPathComponent("sweep", isDirectory: true)
        let leftover = sweepDir.appendingPathComponent("left.body")
        try? fm.createDirectory(at: sweepDir, withIntermediateDirectories: true)
        try? Data("old".utf8).write(to: leftover)
        let sweeper = DriveImporter(api: api(), pick: { [] }, bodyDirectory: sweepDir, sleep: { _ in })
        await sweeper.sweepLeftovers()
        let appModel = (try? String(
            contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent()
                .appendingPathComponent("AppModel.swift"), encoding: .utf8)) ?? ""
        check("launch sweep: a body left by a quit or a crash is removed",
              !fm.fileExists(atPath: leftover.path))
        check("launch sweep: it runs when the app starts, not only at the next import",
              appModel.contains("driveImport.sweepLeftovers()"))

        // A path swapped for a link or a pipe after the walk is refused at open.
        let linked = scratch.appendingPathComponent("linked.txt")
        try? fm.createSymbolicLink(at: linked, withDestinationURL: loose)
        let fifo = scratch.appendingPathComponent("fifo")
        _ = mkfifo(fifo.path, 0o600)
        // Unblocks an open that waits for a writer (the behaviour without O_NONBLOCK),
        // so a regression fails this check instead of hanging the harness.
        let fifoDone = OSAllocatedUnfairLock(initialState: false)
        DispatchQueue.global().async {
            for _ in 0..<100 where !fifoDone.withLock({ $0 }) {
                let fd = open(fifo.path, O_WRONLY | O_NONBLOCK)
                if fd >= 0 { close(fd) }
                usleep(100_000)
            }
        }
        func refusal(_ source: URL) async -> DriveImportFailure? {
            do {
                let body = try await DriveImportBodyWriter.write(
                    source: source, fileName: source.lastPathComponent, parentExternalId: nil,
                    maxFileBytes: 1000, directory: private_)
                try? fm.removeItem(at: body.file)
                return nil
            } catch {
                return (error as? DriveImportFailure) ?? .generic
            }
        }
        let linkRefusal = await refusal(linked)
        let fifoRefusal = await refusal(fifo)
        fifoDone.withLock { $0 = true }
        check("open: a link is not followed (O_NOFOLLOW)", linkRefusal == .unsupported)
        check("open: a pipe is refused without waiting (O_NONBLOCK, then fstat)", fifoRefusal == .unsupported)
        // The open itself, behind the lstat check: each layer refuses on its own.
        func openRefusal(_ url: URL) -> DriveImportFailure? {
            do {
                let (handle, _) = try DriveImportBodyWriter.openRegularFile(atPath: url.path)
                try? handle.close()
                return nil
            } catch {
                return (error as? DriveImportFailure) ?? .generic
            }
        }
        check("open layer: O_NOFOLLOW refuses a link, fstat refuses a pipe, a file opens",
              openRefusal(linked) == .unsupported && openRefusal(fifo) == .unsupported
              && openRefusal(loose) == nil)

        // Cancelled before it starts: nothing is read, nothing is sent.
        let quiet = scratch.appendingPathComponent("quiet", isDirectory: true)
        DriveImportStubProtocol.reset([filesPath: [created("x")]])
        let planned = DriveImportPlan.File(url: loose, name: "loose.txt", size: 5, folder: nil)
        let client = api()
        let outcome = await Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return await DriveImporter.uploadOne(
                planned, parentExternalId: nil, api: client, maxFileBytes: 1000, directory: quiet,
                sleep: { _ in })
        }.value
        check("cancel: a sibling cancelled before it started reads and sends nothing",
              outcome == .cancelled && isEmptyOrMissing(quiet) && DriveImportStubProtocol.calls.isEmpty)

        // The server's retryable:false is final.
        DriveImportStubProtocol.reset([
            limitsPath: [limits()], filesPath: [refused(503, "storage-unavailable", retryable: false)],
        ])
        let noRetrySleeps = DriveImportSleepLog()
        let noRetry = importer(noRetrySleeps, bodies: quiet)
        await noRetry.refreshAvailability()
        await noRetry.importItems([loose])
        check("a refusal the server marks not retryable is not retried",
              noRetry.report?.notUploaded == [.init(name: "loose.txt", reason: .storageUnavailable)]
              && noRetrySleeps.waits.isEmpty
              && DriveImportStubProtocol.calls.filter { $0.path == "/api/drive/files" }.count == 1)

        // Signed out mid-upload: the progress stays reset.
        var slow = created("x")
        slow.delayMs = 1500
        DriveImportStubProtocol.reset([limitsPath: [limits()], filesPath: [slow]])
        let leaving = importer(DriveImportSleepLog(), bodies: quiet)
        await leaving.refreshAvailability()
        let running = Task { await leaving.importItems([loose]) }
        try? await Task.sleep(for: .milliseconds(300))
        leaving.signOut()
        await running.value
        check("sign-out mid-upload: the old run moves no progress and leaves no report",
              leaving.progress == DriveImportProgress() && leaving.report == nil && leaving.phase == .idle)
        return results
    }

    /// `copy` refuses a source shorter or longer than the size it was told.
    nonisolated static func changedWhileReading(_ scratch: URL) -> Bool {
        let source = scratch.appendingPathComponent("changing.bin")
        let sink = scratch.appendingPathComponent("sink.bin")
        func attempt(_ bytes: Int64) -> DriveImportFailure? {
            do {
                try Data(repeating: 1, count: 8).write(to: source)
                FileManager.default.createFile(atPath: sink.path, contents: nil)
                let input = try FileHandle(forReadingFrom: source)
                let output = try FileHandle(forWritingTo: sink)
                defer {
                    try? input.close()
                    try? output.close()
                }
                try DriveImportBodyWriter.copy(from: input, to: output, bytes: bytes)
                return nil
            } catch {
                return (error as? DriveImportFailure) ?? .generic
            }
        }
        return attempt(12) == .changedWhileReading && attempt(4) == .changedWhileReading && attempt(8) == nil
    }
}

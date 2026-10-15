import AppKit
import Foundation
import Observation

// Step D7 (docs/providers/unified-platform-plan.md): "Import to Klorn Drive…".
// The user picks files or folders in the open panel; that pick is the opt-in
// (decision P4). Nothing is read before it, nothing outside it is read, and
// nothing is watched after it: each import is one explicit act. The picked items
// are walked within DriveImportLimits (off the main thread), the folders are
// created, and each file is uploaded through D3's `POST /api/drive/files`,
// streamed from a body file on disk, two at a time, with retries for a rate
// limit or a passing failure. The server's `/api/drive/limits` answers whether
// the Klorn drive is live: its dark 404 hides the menu item and the section, as
// C6's probe does for device calendars.

/// Files and bytes done so far in one import (a failed file counts as done).
struct DriveImportProgress: Equatable, Sendable {
    var totalFiles = 0
    var doneFiles = 0
    var totalBytes: Int64 = 0
    var doneBytes: Int64 = 0

    var fraction: Double {
        if totalBytes > 0 { return Double(doneBytes) / Double(totalBytes) }
        return totalFiles > 0 ? Double(doneFiles) / Double(totalFiles) : 0
    }
}

/// How one import ended.
struct DriveImportReport: Equatable, Sendable {
    var uploaded = 0
    var foldersCreated = 0
    /// Everything not uploaded, with the reason, in the order met.
    var notUploaded: [DriveImportPlan.Skipped] = []
    var caps: Set<DriveImportCap> = []
    /// The refusal that ended the import early (every later file would meet it too).
    var stoppedBy: DriveImportFailure?
    var cancelled = false
}

@MainActor
@Observable
final class DriveImporter {
    enum Availability: Equatable, Sendable { case unknown, available, unavailable }
    enum Phase: Equatable, Sendable { case idle, preparing, uploading, finished }

    /// A probe that failed for any reason but the server's 404 (offline at launch).
    nonisolated static let probeRetryInterval: Duration = .seconds(5 * 60)

    private(set) var availability: Availability = .unknown
    private(set) var limits: DriveLimitsWire?
    private(set) var phase: Phase = .idle
    private(set) var progress = DriveImportProgress()
    private(set) var report: DriveImportReport?

    var isRunning: Bool { phase == .preparing || phase == .uploading }
    /// Live, with a quota (without one every upload is refused), and not already importing.
    var canImport: Bool { availability == .available && limits?.quotaBytes != nil && !isRunning }
    var maxFileBytes: Int64 {
        guard let server = limits?.maxFileBytes, server > 0 else { return DriveImportLimits.maxFileBytes }
        return server
    }

    /// Called once files were picked, before the upload starts (the app shows Settings › Accounts).
    @ObservationIgnored var onImportStarted: (@MainActor () -> Void)?

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let source: any DriveImportFileSource
    @ObservationIgnored private let pick: @MainActor () async -> [URL]
    @ObservationIgnored private let bodyDirectory: URL
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private var runTask: Task<Void, Never>?
    @ObservationIgnored private var probeRetryTask: Task<Void, Never>?
    /// Bumped at sign-out: an answer or an import of the previous session changes nothing.
    @ObservationIgnored private var generation = 0

    init(
        api: APIClient = APIClient(),
        source: any DriveImportFileSource = LocalDriveImportFileSource(),
        pick: @escaping @MainActor () async -> [URL] = { await DriveImporter.presentOpenPanel() },
        bodyDirectory: URL = DriveImportBodyWriter.directory,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.api = api
        self.source = source
        self.pick = pick
        self.bodyDirectory = bodyDirectory
        self.sleep = sleep
    }

    // MARK: Availability

    /// Ask the server whether the Klorn drive is live (launch, sign-in, each Settings visit).
    func refreshAvailability() async {
        let session = generation
        let answer = await Self.probe(api)
        guard session == generation else { return }
        apply(answer)
    }

    private func apply(_ answer: Result<DriveLimitsWire, DriveImportFailure>) {
        if case .success(let wire) = answer { limits = wire }
        if case .failure(.featureOff) = answer { limits = nil }
        availability = Self.availability(after: answer, current: availability)
        if case .failure(let failure) = answer, failure != .featureOff, failure != .unauthorized {
            scheduleProbeRetry()
        }
    }

    private func scheduleProbeRetry() {
        guard probeRetryTask == nil else { return }
        probeRetryTask = Task { [weak self] in
            try? await Task.sleep(for: Self.probeRetryInterval)
            guard !Task.isCancelled else { return }
            self?.probeRetryTask = nil
            await self?.refreshAvailability()
        }
    }

    /// Signing out ends any import in flight and forgets this account's state.
    func signOut() {
        generation += 1
        runTask?.cancel()
        probeRetryTask?.cancel()
        probeRetryTask = nil
        availability = .unknown
        limits = nil
        report = nil
        progress = .init()
        phase = .idle
    }

    // MARK: Importing

    /// The menu item and the Settings button: the open panel, then the import of what was picked.
    func chooseAndImport() async {
        guard canImport else { return }
        let urls = await pick()
        guard !urls.isEmpty, canImport else { return }
        onImportStarted?()
        await importItems(urls)
    }

    /// Import `urls` (what the user picked). Waits until the import ended.
    func importItems(_ urls: [URL]) async {
        guard !isRunning, !urls.isEmpty else { return }
        phase = .preparing
        report = nil
        progress = .init()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.run(urls)
        }
        runTask = task
        await task.value
        // A sign-out and a new import may have replaced it meanwhile.
        if runTask == task { runTask = nil }
    }

    func cancel() { runTask?.cancel() }

    func clearReport() {
        guard !isRunning else { return }
        report = nil
        phase = .idle
    }

    private func run(_ urls: [URL]) async {
        let session = generation
        DriveImportBodyWriter.resetDirectory(bodyDirectory)
        // Asked again: the server may have turned the drive off, or set a quota, since.
        let answer = await Self.probe(api)
        guard session == generation else { return }
        apply(answer)
        if let stop = Self.refusalBeforeImport(answer) {
            return finish(DriveImportReport(stoppedBy: stop), session: session)
        }
        let walkLimits = DriveImportWalkLimits(maxFileBytes: maxFileBytes)
        let source = self.source
        let plan = await Task.detached(priority: .userInitiated) {
            DriveImportWalk.plan(picked: urls, source: source, limits: walkLimits)
        }.value
        var report = DriveImportReport(notUploaded: plan.skipped, caps: plan.caps)
        guard !Task.isCancelled else {
            report.cancelled = true
            return finish(report, session: session)
        }
        phase = .uploading
        progress = .init(totalFiles: plan.files.count, totalBytes: plan.totalBytes)
        let folders = await createFolders(plan.folders, into: &report)
        var queue: [DriveImportPlan.File] = []
        for file in plan.files {
            if let folder = file.folder, folders[folder] == nil {
                report.notUploaded.append(.init(name: file.name, reason: report.stoppedBy ?? .folderMissing))
                progress.doneFiles += 1
                progress.doneBytes += file.size
            } else {
                queue.append(file)
            }
        }
        if report.stoppedBy == nil {
            await uploadFiles(queue, folders: folders, into: &report)
        } else {
            report.notUploaded += queue.map { .init(name: $0.name, reason: report.stoppedBy ?? .cancelled) }
        }
        report.cancelled = Task.isCancelled && report.stoppedBy == nil
        finish(report, session: session)
    }

    private func finish(_ report: DriveImportReport, session: Int) {
        // Signed out meanwhile: the report belongs to the account that left.
        guard session == generation else { return }
        if report.stoppedBy == .featureOff {
            availability = .unavailable
            limits = nil
        }
        self.report = report
        phase = .finished
    }

    /// Each planned folder, parents first. A folder whose parent failed is not
    /// tried (its files are reported under the parent's failure).
    private func createFolders(
        _ folders: [DriveImportPlan.Folder], into report: inout DriveImportReport
    ) async -> [Int: String] {
        var created: [Int: String] = [:]
        let api = self.api
        let sleep = self.sleep
        for folder in folders {
            guard !Task.isCancelled, report.stoppedBy == nil else { break }
            let parent: String?
            if let parentId = folder.parent {
                guard let id = created[parentId] else { continue }
                parent = id
            } else {
                parent = nil
            }
            let name = folder.name
            let result = await Self.withRetries(sleep: sleep) {
                try await api.createDriveFolder(name: name, parentExternalId: parent)
            }
            switch result {
            case .success(let externalId):
                created[folder.id] = externalId
                report.foldersCreated += 1
            case .failure(let failure) where DriveImportRules.stopsImport(failure):
                report.stoppedBy = failure
            case .failure(let failure):
                report.notUploaded.append(.init(name: name, reason: failure))
            }
        }
        return created
    }

    /// Up to `uploadConcurrency` uploads at once; a refusal every file would meet stops the rest.
    private func uploadFiles(
        _ files: [DriveImportPlan.File], folders: [Int: String], into report: inout DriveImportReport
    ) async {
        let api = self.api
        let sleep = self.sleep
        let directory = bodyDirectory
        let maxBytes = maxFileBytes
        var pending = files[...]
        await withTaskGroup(of: (DriveImportPlan.File, DriveImportFailure?).self) { group in
            func start(_ file: DriveImportPlan.File) {
                let parent = file.folder.flatMap { folders[$0] }
                group.addTask {
                    let failure = await Self.uploadOne(
                        file, parentExternalId: parent, api: api, maxFileBytes: maxBytes,
                        directory: directory, sleep: sleep)
                    return (file, failure)
                }
            }
            for _ in 0..<DriveImportLimits.uploadConcurrency {
                // Cancelled while the folders were made: nothing more is read.
                guard !Task.isCancelled, let file = pending.popFirst() else { break }
                start(file)
            }
            while let (file, failure) = await group.next() {
                progress.doneFiles += 1
                progress.doneBytes += file.size
                if let failure {
                    if DriveImportRules.stopsImport(failure), report.stoppedBy == nil {
                        report.stoppedBy = failure
                        group.cancelAll()
                    }
                    let shown = failure == .cancelled ? (report.stoppedBy ?? .cancelled) : failure
                    report.notUploaded.append(.init(name: file.name, reason: shown))
                } else {
                    report.uploaded += 1
                }
                guard report.stoppedBy == nil, !Task.isCancelled, let next = pending.popFirst() else { continue }
                start(next)
            }
        }
        report.notUploaded += pending.map { .init(name: $0.name, reason: report.stoppedBy ?? .cancelled) }
    }

    // MARK: Off the main thread

    /// One file: its body written under a coordinated read, then sent; nil when it was uploaded.
    nonisolated static func uploadOne(
        _ file: DriveImportPlan.File, parentExternalId: String?, api: APIClient, maxFileBytes: Int64,
        directory: URL, sleep: @escaping @Sendable (Duration) async throws -> Void
    ) async -> DriveImportFailure? {
        let body: DriveImportBody
        do {
            body = try await DriveImportBodyWriter.write(
                source: file.url, fileName: file.name, parentExternalId: parentExternalId,
                maxFileBytes: maxFileBytes, directory: directory)
        } catch let failure as DriveImportFailure {
            return Task.isCancelled ? .cancelled : failure
        } catch {
            return Task.isCancelled ? .cancelled : .unreadable
        }
        defer { try? FileManager.default.removeItem(at: body.file) }
        let result = await withRetries(sleep: sleep) {
            try await api.uploadDriveFile(bodyFile: body.file, boundary: body.boundary)
        }
        if case .failure(let failure) = result { return failure }
        return nil
    }

    /// `operation`, tried again after a wait while it fails for a passing reason.
    nonisolated static func withRetries<T: Sendable>(
        sleep: @Sendable (Duration) async throws -> Void,
        _ operation: @Sendable () async throws -> T
    ) async -> Result<T, DriveImportFailure> {
        var attempt = 1
        while true {
            if Task.isCancelled { return .failure(.cancelled) }
            do {
                return .success(try await operation())
            } catch let error as DriveRequestError {
                let failure = error.failure
                guard DriveImportRules.isRetryable(failure), attempt < DriveImportLimits.maxAttempts else {
                    return .failure(failure)
                }
                let wait = DriveImportRules.backoffSeconds(attempt: attempt, retryAfter: error.retryAfter)
                do { try await sleep(.seconds(wait)) } catch { return .failure(.cancelled) }
                attempt += 1
            } catch {
                return .failure(Task.isCancelled ? .cancelled : .generic)
            }
        }
    }

    nonisolated static func probe(_ api: APIClient) async -> Result<DriveLimitsWire, DriveImportFailure> {
        do {
            return .success(try await api.fetchDriveLimits())
        } catch let error as DriveRequestError {
            Log.net.debug("drive limits probe: \(String(describing: error), privacy: .private)")
            return .failure(error.failure)
        } catch {
            return .failure(.generic)
        }
    }

    /// Why an import cannot start after this probe answer: the drive is off, the
    /// session ended, no quota is set (every upload would be refused), or no answer.
    nonisolated static func refusalBeforeImport(
        _ answer: Result<DriveLimitsWire, DriveImportFailure>
    ) -> DriveImportFailure? {
        switch answer {
        case .success(let wire): wire.quotaBytes == nil ? .quotaNotConfigured : nil
        case .failure(let failure): failure
        }
    }

    /// The 404-hides rule: the dark gate's 404 hides the feature, an answer shows
    /// it, a lost session forgets it, anything else leaves it as it was.
    nonisolated static func availability(
        after answer: Result<DriveLimitsWire, DriveImportFailure>, current: Availability
    ) -> Availability {
        switch answer {
        case .success: .available
        case .failure(.featureOff): .unavailable
        case .failure(.unauthorized): .unknown
        case .failure: current
        }
    }

    // MARK: The open panel

    /// Files and folders, several at once; nothing is read until the user confirms.
    static func presentOpenPanel() async -> [URL] {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        panel.resolvesAliases = true
        panel.treatsFilePackagesAsDirectories = false
        panel.prompt = L("driveImport.panel.prompt")
        panel.message = L("driveImport.panel.message")
        NSApp.activate(ignoringOtherApps: true)
        let response = await withCheckedContinuation { (continuation: CheckedContinuation<NSApplication.ModalResponse, Never>) in
            panel.begin { continuation.resume(returning: $0) }
        }
        return response == .OK ? panel.urls : []
    }
}

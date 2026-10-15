import AppKit
import Observation

/// The drive list for the Files section and Today's recent files (P12).
/// Read-only: GET /api/drive/files, which answers only the user's own rows of
/// the sources that are on. Nothing here calls a model.
///
/// Session hygiene: `reset()` (sign-out) bumps `generation`; an answer that
/// arrives for an older generation, or for a search/folder the user already
/// left, writes nothing.
@MainActor
@Observable
final class FilesStore {
    enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        case failed
    }

    private let api: APIClient

    /// Opens a URL outside the app. A seam: the self-check records instead of
    /// launching a browser.
    @ObservationIgnored var openURL: @MainActor (URL) -> Bool = { NSWorkspace.shared.open($0) }

    // MARK: List
    private(set) var files: [DriveFileWire] = []
    private(set) var phase: Phase = .idle
    private(set) var nextCursor: String?
    private(set) var loadingMore = false
    private(set) var loadMoreFailed = false
    /// The search the list on screen answers. While a new search runs, the
    /// last list stays (`stale`) but pages nothing.
    private(set) var appliedQuery = ""
    private(set) var stale = false
    /// The folders walked into; the last one is listed.
    private(set) var trail: [FolderCrumb] = []

    // MARK: Today
    private(set) var recent: [DriveFileWire] = []
    private(set) var recentPhase: Phase = .idle

    // MARK: Download
    private(set) var downloadingId: String?
    private(set) var downloadError: (kind: FileDownloadError, name: String)?

    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var listRequest = 0

    init(api: APIClient) {
        self.api = api
    }

    var folder: FolderCrumb? { trail.last }
    var hasMore: Bool { nextCursor != nil && !stale }

    /// Everything the leaving account fetched; in-flight answers are dropped.
    func reset() {
        generation += 1
        listRequest += 1
        files = []
        phase = .idle
        nextCursor = nil
        loadingMore = false
        loadMoreFailed = false
        appliedQuery = ""
        stale = false
        trail = []
        recent = []
        recentPhase = .idle
        downloadingId = nil
        downloadError = nil
    }

    var isClean: Bool {
        files.isEmpty && phase == .idle && nextCursor == nil && trail.isEmpty && recent.isEmpty
            && recentPhase == .idle && downloadingId == nil && downloadError == nil && appliedQuery.isEmpty
    }

    // MARK: Loading

    /// The first page for `query` in the current folder. A new search keeps
    /// the last list on screen until it answers; a new folder does not (see
    /// `enter`), so no row of the folder just left stays clickable.
    func search(_ query: String) async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if text == appliedQuery, phase == .loaded || phase == .loading { return }
        await loadFirstPage(query: text)
    }

    func reload() async {
        await loadFirstPage(query: appliedQuery)
    }

    private func loadFirstPage(query: String) async {
        listRequest += 1
        let request = listRequest
        let session = generation
        let previous = (query: appliedQuery, phase: phase)
        appliedQuery = query
        // A next page in flight belongs to the list this one replaces.
        loadingMore = false
        stale = !files.isEmpty
        if files.isEmpty { phase = .loading }
        loadMoreFailed = false
        let path = FilesRules.listPath(query: query, folder: folder?.externalId)
        do {
            let page = try await api.get(path, as: DriveFilesPage.self)
            guard session == generation, request == listRequest else { return }
            files = page.files
            nextCursor = page.nextCursor
            phase = .loaded
            stale = false
        } catch where FilesRules.isCancellation(error) || Task.isCancelled {
            // Not a failure: put back the list's own state, so the search
            // is asked again next time instead of flashing an error.
            guard session == generation, request == listRequest else { return }
            appliedQuery = previous.query
            phase = files.isEmpty ? .idle : previous.phase
            stale = false
        } catch {
            guard session == generation, request == listRequest else { return }
            Log.app.debug("files list failed: \(String(describing: error), privacy: .private)")
            files = []
            nextCursor = nil
            phase = .failed
            stale = false
        }
    }

    func loadMore() async {
        guard let cursor = nextCursor, !stale, !loadingMore else { return }
        let request = listRequest
        let session = generation
        loadingMore = true
        loadMoreFailed = false
        let path = FilesRules.listPath(query: appliedQuery, cursor: cursor, folder: folder?.externalId)
        // Superseded (a new search or folder) or signed out: the newer list
        // owns `loadingMore` now and already cleared it.
        defer { if session == generation, request == listRequest { loadingMore = false } }
        do {
            let page = try await api.get(path, as: DriveFilesPage.self)
            guard session == generation, request == listRequest else { return }
            files = FilesRules.appending(page.files, to: files)
            nextCursor = page.nextCursor
        } catch where FilesRules.isCancellation(error) || Task.isCancelled {
            return
        } catch {
            guard session == generation, request == listRequest else { return }
            loadMoreFailed = true
        }
    }

    func refreshRecent() async {
        let session = generation
        if recent.isEmpty { recentPhase = .loading }
        do {
            let page = try await api.get(
                FilesRules.listPath(limit: FilesRules.recentLimit), as: DriveFilesPage.self)
            guard session == generation else { return }
            recent = Array(page.files.prefix(FilesRules.recentLimit))
            recentPhase = .loaded
        } catch {
            guard session == generation, !FilesRules.isCancellation(error) else { return }
            // A failed refresh keeps rows already shown.
            if recent.isEmpty { recentPhase = .failed }
        }
    }

    // MARK: Folders

    /// Walk into a Klorn drive folder. The list clears first.
    func enter(_ file: DriveFileWire) async {
        guard FilesRules.openAction(for: file) == .folder else { return }
        await walk(trail + [FolderCrumb(id: file.id, externalId: file.externalId, name: file.name)])
    }

    /// Back to crumb `index` (-1: all files).
    func walk(to index: Int) async {
        await walk(FilesRules.trail(trail, to: index))
    }

    private func walk(_ next: [FolderCrumb]) async {
        trail = next
        files = []
        nextCursor = nil
        stale = false
        phase = .loading
        await loadFirstPage(query: appliedQuery)
    }

    // MARK: Opening

    /// Opens a row: a Klorn folder is walked into, a Klorn file is
    /// downloaded through its signed link, an external row opens its own
    /// https link. Returns what it did, for the harness.
    @discardableResult
    func open(_ file: DriveFileWire) async -> FileOpenAction {
        let action = FilesRules.openAction(for: file)
        switch action {
        case .folder: await enter(file)
        case .download: await download(file)
        case .link(let url): _ = openURL(url)
        case .none: break
        }
        return action
    }

    /// GET /api/drive/files/:id/download with the Bearer token, then hand the
    /// signed link (validated: https, no credentials) to the default browser,
    /// which saves it as the attachment the server names. The token never
    /// goes into a URL and the link is neither stored nor logged.
    func download(_ file: DriveFileWire) async {
        guard downloadingId == nil else { return }
        let session = generation
        downloadingId = file.id
        downloadError = nil
        defer { if session == generation { downloadingId = nil } }
        do {
            let answer = try await api.get(
                FilesRules.downloadLinkPath(id: file.id), as: DriveDownloadWire.self)
            guard session == generation else { return }
            guard let url = FilesRules.safeDownloadURL(answer.url, apiBase: api.base) else {
                Log.app.error("drive download: the API answered an unusable link")
                downloadError = (.failed, file.name)
                return
            }
            if !openURL(url) { downloadError = (.failed, file.name) }
        } catch {
            guard session == generation, !FilesRules.isCancellation(error) else { return }
            downloadError = (FilesRules.downloadError(for: error), file.name)
        }
    }

    func dismissDownloadError() { downloadError = nil }

    /// Today's recent files hand a folder over: Files opens at it.
    func startAt(folder file: DriveFileWire) {
        listRequest += 1
        trail = [FolderCrumb(id: file.id, externalId: file.externalId, name: file.name)]
        files = []
        nextCursor = nil
        loadingMore = false
        loadMoreFailed = false
        downloadError = nil
        phase = .idle
        appliedQuery = ""
        stale = false
    }

    // MARK: Render seam

    /// Offscreen previews only: no network, no disk.
    func seedForRender(
        files: [DriveFileWire], nextCursor: String? = nil, phase: Phase = .loaded,
        trail: [FolderCrumb] = [], query: String = "", recent: [DriveFileWire] = [],
        downloadError: (FileDownloadError, String)? = nil
    ) {
        self.files = files
        self.nextCursor = nextCursor
        self.phase = phase
        self.trail = trail
        self.appliedQuery = query
        self.recent = recent
        self.recentPhase = .loaded
        self.downloadError = downloadError.map { (kind: $0.0, name: $0.1) }
    }
}

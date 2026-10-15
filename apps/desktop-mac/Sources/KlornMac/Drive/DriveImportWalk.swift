import Foundation
import os

// Step D7: what one import will upload, decided before any byte is read. A
// picked file is one upload; a picked folder becomes a Klorn folder with what is
// inside it, walked within the caps of DriveImportLimits. Links and Finder
// aliases are never followed (one inside a picked folder may point anywhere,
// which the user did not pick: P4, and an alias's bookmark names its target),
// packages are not one file, and hidden files are left out. A folder is read one
// entry at a time, every entry looked at counts toward a cap, and a Cancel is
// seen before the next entry.

/// One entry of the file system as the walk needs it.
struct DriveImportEntry: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case file(size: Int64?)
        case folder
        /// A link, a package (an app, some documents) or anything that is not a plain file.
        case unsupported
        /// An old-style iCloud placeholder (`.Name.icloud`): the file is not on this Mac.
        case placeholder(name: String)
    }

    let kind: Kind
    let name: String
    let isHidden: Bool
}

/// The file system the walk reads; the self-check passes a fake one.
protocol DriveImportFileSource: Sendable {
    /// nil: the entry cannot be read.
    func entry(at url: URL) -> DriveImportEntry?
    /// Each entry of a folder, one at a time, until `body` answers false (the
    /// listing is never loaded whole). False: the folder could not be read.
    func forEachChild(of url: URL, _ body: (URL) -> Bool) -> Bool
}

/// Set by Cancel and by sign-out; the walk checks it before every entry.
final class DriveImportCancelFlag: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: false)
    var isCancelled: Bool { state.withLock { $0 } }
    func cancel() { state.withLock { $0 = true } }
}

/// The bounds the walk keeps (DriveImportLimits, with the server's file cap).
struct DriveImportWalkLimits: Equatable, Sendable {
    var maxFiles = DriveImportLimits.maxFiles
    var maxFolders = DriveImportLimits.maxFolders
    var maxDepth = DriveImportLimits.maxFolderDepth
    var maxTotalBytes = DriveImportLimits.maxTotalBytes
    var maxFileBytes = DriveImportLimits.maxFileBytes
    var maxExamined = DriveImportLimits.maxEntriesExamined
}

/// A cap one import reached. Whatever lay past it was not walked.
enum DriveImportCap: String, CaseIterable, Hashable, Sendable {
    case files, folders, depth, bytes, examined
}

/// What one import will do, in order: create the folders, then upload the files.
struct DriveImportPlan: Equatable, Sendable {
    struct Folder: Equatable, Sendable {
        let id: Int
        let name: String
        /// Another planned folder, or nil for the drive's root. Always created before this one.
        let parent: Int?
    }
    struct File: Equatable, Sendable {
        let url: URL
        let name: String
        let size: Int64
        let folder: Int?
    }
    struct Skipped: Equatable, Sendable {
        let name: String
        let reason: DriveImportFailure
    }

    var folders: [Folder] = []
    var files: [File] = []
    var skipped: [Skipped] = []
    var totalBytes: Int64 = 0
    var caps: Set<DriveImportCap> = []
    /// The walk was cancelled before it ended.
    var cancelled = false
}

enum DriveImportWalk {
    /// The plan for what the user picked, in the order picked; a folder's
    /// entries in the order the source hands them out. Pure over `source`;
    /// `cancel` is checked before every entry.
    static func plan(
        picked: [URL], source: some DriveImportFileSource, limits: DriveImportWalkLimits = .init(),
        cancel: DriveImportCancelFlag? = nil
    ) -> DriveImportPlan {
        var walker = Walker(source: source, limits: limits, cancel: cancel)
        for url in picked {
            guard !walker.stopped else { break }
            // The pick itself: a link the user chose is resolved (they chose it);
            // links met inside a folder are not.
            walker.visit(url.resolvingSymlinksInPath(), parent: nil, depth: 0, picked: true)
        }
        return walker.plan
    }

    private struct Walker<Source: DriveImportFileSource> {
        let source: Source
        let limits: DriveImportWalkLimits
        let cancel: DriveImportCancelFlag?
        var plan = DriveImportPlan()
        /// A file cap (count or bytes), the examined cap or a cancel: nothing more is looked at.
        var stopped = false
        /// Entries looked at, whatever became of them.
        var examined = 0

        init(source: Source, limits: DriveImportWalkLimits, cancel: DriveImportCancelFlag?) {
            self.source = source
            self.limits = limits
            self.cancel = cancel
        }

        mutating func visit(_ url: URL, parent: Int?, depth: Int, picked: Bool) {
            guard !stopped else { return }
            if cancel?.isCancelled == true {
                plan.cancelled = true
                stopped = true
                return
            }
            guard examined < limits.maxExamined else { return stop(.examined) }
            examined += 1
            guard let entry = source.entry(at: url) else {
                plan.skipped.append(.init(name: url.lastPathComponent, reason: .unreadable))
                return
            }
            if case .placeholder(let name) = entry.kind {
                plan.skipped.append(.init(name: name, reason: .notDownloaded))
                return
            }
            // Hidden entries inside a folder (.DS_Store and the like) are left out
            // silently; a hidden file the user picked by name still goes.
            if entry.isHidden && !picked { return }
            switch entry.kind {
            case .file(let size): addFile(url: url, name: entry.name, size: size, folder: parent)
            case .folder: addFolder(url: url, name: entry.name, parent: parent, depth: depth)
            case .unsupported: plan.skipped.append(.init(name: entry.name, reason: .unsupported))
            case .placeholder: break
            }
        }

        private mutating func addFile(url: URL, name: String, size: Int64?, folder: Int?) {
            if let refusal = DriveImportRules.sizeVerdict(size, maxFileBytes: limits.maxFileBytes) {
                plan.skipped.append(.init(name: name, reason: refusal))
                return
            }
            let bytes = size ?? 0
            if plan.files.count >= limits.maxFiles {
                return stop(.files)
            }
            if plan.totalBytes + bytes > limits.maxTotalBytes {
                return stop(.bytes)
            }
            plan.files.append(.init(url: url, name: name, size: bytes, folder: folder))
            plan.totalBytes += bytes
        }

        private mutating func addFolder(url: URL, name: String, parent: Int?, depth: Int) {
            guard depth <= limits.maxDepth else {
                plan.caps.insert(.depth)
                return
            }
            guard plan.folders.count < limits.maxFolders else {
                plan.caps.insert(.folders)
                return
            }
            let id = plan.folders.count
            plan.folders.append(.init(id: id, name: name, parent: parent))
            var visited = 0
            let readable = source.forEachChild(of: url) { child in
                visited += 1
                visit(child, parent: id, depth: depth + 1, picked: false)
                return !stopped
            }
            guard !readable else { return }
            // Nothing inside was looked at, so this folder is still the last one planned.
            if visited == 0 { plan.folders.removeLast() }
            plan.skipped.append(.init(name: name, reason: .unreadable))
        }

        private mutating func stop(_ cap: DriveImportCap) {
            plan.caps.insert(cap)
            stopped = true
        }
    }
}

/// The real file system. Sizes are the logical size, which a cloud file that is
/// not downloaded yet reports too (the walk never downloads anything).
struct LocalDriveImportFileSource: DriveImportFileSource {
    static let keys: [URLResourceKey] = [
        .isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .isAliasFileKey, .isPackageKey, .isHiddenKey,
        .fileSizeKey,
    ]

    func entry(at url: URL) -> DriveImportEntry? {
        guard let values = try? url.resourceValues(forKeys: Set(Self.keys)) else { return nil }
        let name = url.lastPathComponent
        let hidden = values.isHidden == true || name.hasPrefix(".")
        if let original = Self.placeholderName(name) {
            return DriveImportEntry(kind: .placeholder(name: original), name: original, isHidden: false)
        }
        let kind: DriveImportEntry.Kind
        if values.isSymbolicLink == true || values.isAliasFile == true {
            kind = .unsupported
        } else if values.isDirectory == true {
            kind = values.isPackage == true ? .unsupported : .folder
        } else if values.isRegularFile == true {
            kind = .file(size: values.fileSize.map(Int64.init))
        } else {
            kind = .unsupported
        }
        return DriveImportEntry(kind: kind, name: name, isHidden: hidden)
    }

    /// One level, lazily: the enumerator reads the folder as it is asked.
    func forEachChild(of url: URL, _ body: (URL) -> Bool) -> Bool {
        final class Failure { var happened = false }
        let failure = Failure()
        guard let entries = FileManager.default.enumerator(
            at: url, includingPropertiesForKeys: Self.keys, options: [.skipsSubdirectoryDescendants],
            errorHandler: { _, _ in
                failure.happened = true
                return false
            })
        else { return false }
        while let child = entries.nextObject() as? URL {
            if !body(child) { break }
        }
        return !failure.happened
    }

    /// `.Report.pdf.icloud` → `Report.pdf`: the stub older iCloud Drive left for a
    /// file that is not on this Mac.
    static func placeholderName(_ name: String) -> String? {
        let suffix = ".icloud"
        guard name.hasPrefix("."), name.hasSuffix(suffix), name.count > suffix.count + 1 else { return nil }
        return String(name.dropFirst().dropLast(suffix.count))
    }
}

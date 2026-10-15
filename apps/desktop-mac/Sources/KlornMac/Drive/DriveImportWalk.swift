import Foundation

// Step D7: what one import will upload, decided before any byte is read. A
// picked file is one upload; a picked folder becomes a Klorn folder with what is
// inside it, walked within the caps of DriveImportLimits. Links are never
// followed (one inside a picked folder may point anywhere, which the user did
// not pick: P4), packages are not one file, and hidden files are left out.

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
    /// nil: the folder cannot be read.
    func children(of url: URL) -> [URL]?
}

/// The bounds the walk keeps (DriveImportLimits, with the server's file cap).
struct DriveImportWalkLimits: Equatable, Sendable {
    var maxFiles = DriveImportLimits.maxFiles
    var maxFolders = DriveImportLimits.maxFolders
    var maxDepth = DriveImportLimits.maxFolderDepth
    var maxTotalBytes = DriveImportLimits.maxTotalBytes
    var maxFileBytes = DriveImportLimits.maxFileBytes
}

/// A cap one import reached. Whatever lay past it was not walked.
enum DriveImportCap: String, CaseIterable, Hashable, Sendable {
    case files, folders, depth, bytes
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
}

enum DriveImportWalk {
    /// The plan for what the user picked, in the order picked; a folder's
    /// entries in name order. Pure over `source`.
    static func plan(
        picked: [URL], source: some DriveImportFileSource, limits: DriveImportWalkLimits = .init()
    ) -> DriveImportPlan {
        var walker = Walker(source: source, limits: limits)
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
        var plan = DriveImportPlan()
        /// A file cap (count or bytes) was reached: nothing more is added.
        var stopped = false

        init(source: Source, limits: DriveImportWalkLimits) {
            self.source = source
            self.limits = limits
        }

        mutating func visit(_ url: URL, parent: Int?, depth: Int, picked: Bool) {
            guard !stopped else { return }
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
            guard let children = source.children(of: url) else {
                plan.skipped.append(.init(name: name, reason: .unreadable))
                return
            }
            let id = plan.folders.count
            plan.folders.append(.init(id: id, name: name, parent: parent))
            let ordered = children.sorted { $0.lastPathComponent < $1.lastPathComponent }
            for child in ordered {
                guard !stopped else { return }
                visit(child, parent: id, depth: depth + 1, picked: false)
            }
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
        .isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .isPackageKey, .isHiddenKey, .fileSizeKey,
    ]

    func entry(at url: URL) -> DriveImportEntry? {
        guard let values = try? url.resourceValues(forKeys: Set(Self.keys)) else { return nil }
        let name = url.lastPathComponent
        let hidden = values.isHidden == true || name.hasPrefix(".")
        if let original = Self.placeholderName(name) {
            return DriveImportEntry(kind: .placeholder(name: original), name: original, isHidden: false)
        }
        let kind: DriveImportEntry.Kind
        if values.isSymbolicLink == true {
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

    func children(of url: URL) -> [URL]? {
        try? FileManager.default.contentsOfDirectory(
            at: url, includingPropertiesForKeys: Self.keys, options: [])
    }

    /// `.Report.pdf.icloud` → `Report.pdf`: the stub older iCloud Drive left for a
    /// file that is not on this Mac.
    static func placeholderName(_ name: String) -> String? {
        let suffix = ".icloud"
        guard name.hasPrefix("."), name.hasSuffix(suffix), name.count > suffix.count + 1 else { return nil }
        return String(name.dropFirst().dropLast(suffix.count))
    }
}

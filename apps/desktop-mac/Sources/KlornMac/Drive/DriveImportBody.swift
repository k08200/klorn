import Foundation
import os

// Step D7: one upload's request body, written to a file of its own so URLSession
// can stream it from disk (`upload(for:fromFile:)`): the framing, then the
// file's bytes copied a chunk at a time, then the closing boundary. Memory stays
// at one chunk; disk holds one body per upload in flight (at most 25 MiB each).
// Bodies are private: a 0700 folder in the app's Caches folder, each body 0600,
// created exclusively; the folder is emptied at launch and when an import starts.
//
// Cloud files: the source is read inside an NSFileCoordinator read, so a file in
// iCloud Drive (or another File Provider folder, such as a MYBOX folder) that is
// not on this Mac yet is downloaded by the system before it is read. When that
// download fails (offline, a provider error) the file is reported as "not
// downloaded" rather than sent partly. The read runs on a queue of its own: a
// download can take a while and must not hold the main thread or a Swift
// concurrency thread. A cancel stops the coordination, and nothing is opened
// once it was seen. The path is opened without following a link and without
// waiting, and read only if it is a regular file: a path swapped after the walk
// for a link or a pipe is refused.

/// A request body on disk, ready to send. Delete it once it was sent.
struct DriveImportBody: Sendable {
    let file: URL
    let boundary: String
    /// The bytes of the source that went into the body (the `size` field).
    let size: Int64
}

enum DriveImportBodyWriter {
    /// The bundle id outside a packaged app (`swift run`): the one make-app.sh writes.
    static let bundleIdFallback = "ai.klorn.desktop"
    /// The body folder and each body: the user's only.
    static let directoryPermissions: Int16 = 0o700
    static let bodyPermissions: mode_t = 0o600

    /// `~/Library/Caches/<bundle id>/drive-import/`; emptied at launch and when an import starts.
    static var directory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return caches
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? bundleIdFallback, isDirectory: true)
            .appendingPathComponent("drive-import", isDirectory: true)
    }

    private static let queue = DispatchQueue(label: "ai.klorn.drive-import.read", qos: .utility, attributes: .concurrent)

    /// Remove what an earlier run left behind (a quit or a crash between write and delete).
    static func resetDirectory(_ directory: URL = directory) {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Write the body for `source`, off the calling thread, under a coordinated read.
    static func write(
        source: URL, fileName: String, parentExternalId: String?, maxFileBytes: Int64,
        directory: URL = directory
    ) async throws -> DriveImportBody {
        if Task.isCancelled { throw DriveImportFailure.cancelled }
        let coordinator = CoordinatorBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<DriveImportBody, Error>) in
                queue.async {
                    continuation.resume(with: Result {
                        guard !coordinator.isCancelled else { throw DriveImportFailure.cancelled }
                        return try coordinatedWrite(
                            source: source, fileName: fileName, parentExternalId: parentExternalId,
                            maxFileBytes: maxFileBytes, directory: directory, coordinator: coordinator)
                    })
                }
            }
        } onCancel: {
            coordinator.cancel()
        }
    }

    private static func coordinatedWrite(
        source: URL, fileName: String, parentExternalId: String?, maxFileBytes: Int64,
        directory: URL, coordinator: CoordinatorBox
    ) throws -> DriveImportBody {
        // Before any coordination: the path must still be a regular file, not a link.
        try requireRegularFile(atPath: source.path)
        var coordinationError: NSError?
        var outcome: Result<DriveImportBody, Error> = .failure(DriveImportFailure.unreadable)
        coordinator.value.coordinate(readingItemAt: source, options: [.withoutChanges], error: &coordinationError) { url in
            outcome = Result {
                guard !coordinator.isCancelled else { throw DriveImportFailure.cancelled }
                return try frame(
                    source: url, fileName: fileName, parentExternalId: parentExternalId,
                    maxFileBytes: maxFileBytes, directory: directory)
            }
        }
        if let coordinationError {
            if coordinationError.domain == NSCocoaErrorDomain && coordinationError.code == NSUserCancelledError {
                throw DriveImportFailure.cancelled
            }
            Log.net.error("drive import: coordinated read failed: \(coordinationError.code, privacy: .public)")
            throw isCloudItem(source) ? DriveImportFailure.notDownloaded : .unreadable
        }
        do {
            return try outcome.get()
        } catch let error as DriveImportFailure {
            throw error
        } catch {
            Log.net.error("drive import: read failed: \(String(describing: error), privacy: .private)")
            throw isCloudItem(source) ? DriveImportFailure.notDownloaded : .unreadable
        }
    }

    /// `lstat`: a link, a pipe, a device or a folder is not a file to send.
    private static func requireRegularFile(atPath path: String) throws {
        var info = stat()
        guard lstat(path, &info) == 0 else { throw DriveImportFailure.unreadable }
        guard info.st_mode & S_IFMT == S_IFREG else { throw DriveImportFailure.unsupported }
    }

    /// The source opened without following a link and without waiting (a pipe
    /// would block until a writer came), then checked to be a regular file.
    static func openRegularFile(atPath path: String) throws -> (FileHandle, Int64) {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else {
            throw errno == ELOOP ? DriveImportFailure.unsupported : DriveImportFailure.unreadable
        }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
            close(fd)
            throw DriveImportFailure.unsupported
        }
        // A regular file: reads may block again (a cloud file materialises on read).
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
        return (FileHandle(fileDescriptor: fd, closeOnDealloc: true), Int64(info.st_size))
    }

    /// The body folder, created 0700 (and made 0700 if an older build left it wider).
    static func prepareDirectory(_ directory: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: directoryPermissions])
        try fm.setAttributes([.posixPermissions: directoryPermissions], ofItemAtPath: directory.path)
    }

    /// A new body file, 0600, created exclusively (never an existing file or a link).
    static func createBody(in directory: URL) throws -> (URL, FileHandle) {
        let url = directory.appendingPathComponent("\(UUID().uuidString).body")
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, bodyPermissions)
        guard fd >= 0 else { throw DriveImportFailure.generic }
        // The process umask can only narrow the mode; set it exactly.
        _ = fchmod(fd, bodyPermissions)
        return (url, FileHandle(fileDescriptor: fd, closeOnDealloc: true))
    }

    /// Framing and bytes, inside the coordinated read (the file is local by now).
    private static func frame(
        source: URL, fileName: String, parentExternalId: String?, maxFileBytes: Int64, directory: URL
    ) throws -> DriveImportBody {
        let (input, size) = try openRegularFile(atPath: source.path)
        defer { try? input.close() }
        if let refusal = DriveImportRules.sizeVerdict(size, maxFileBytes: maxFileBytes) {
            throw refusal
        }
        try prepareDirectory(directory)
        let boundary = DriveMultipart.makeBoundary()
        let (bodyURL, output) = try createBody(in: directory)
        do {
            defer { try? output.close() }
            try output.write(contentsOf: DriveMultipart.head(
                boundary: boundary, size: size, parentExternalId: parentExternalId, fileName: fileName))
            try copy(from: input, to: output, bytes: size)
            try output.write(contentsOf: DriveMultipart.tail(boundary: boundary))
        } catch {
            try? FileManager.default.removeItem(at: bodyURL)
            throw error
        }
        return DriveImportBody(file: bodyURL, boundary: boundary, size: size)
    }

    /// Exactly `bytes` bytes, a chunk at a time. A file that ends early or goes on
    /// past them changed while it was read: refused, never sent as a mix.
    static func copy(from input: FileHandle, to output: FileHandle, bytes: Int64) throws {
        var remaining = bytes
        while remaining > 0 {
            try autoreleasepool {
                let want = Int(min(Int64(DriveImportLimits.copyChunkBytes), remaining))
                guard let chunk = try input.read(upToCount: want), !chunk.isEmpty else {
                    throw DriveImportFailure.changedWhileReading
                }
                try output.write(contentsOf: chunk)
                remaining -= Int64(chunk.count)
            }
        }
        if let extra = try input.read(upToCount: 1), !extra.isEmpty {
            throw DriveImportFailure.changedWhileReading
        }
    }

    /// A file iCloud Drive or another File Provider keeps (its read failing is a download failing).
    static func isCloudItem(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isUbiquitousItemKey]))?.isUbiquitousItem == true
    }
}

/// NSFileCoordinator is not Sendable, but `cancel()` is documented as callable
/// from any thread, and it is the only call made on it from the cancel handler.
/// The flag lets the reading queue see a cancel that came before `coordinate`.
private final class CoordinatorBox: @unchecked Sendable {
    let value = NSFileCoordinator(filePresenter: nil)
    private let cancelled = OSAllocatedUnfairLock(initialState: false)

    var isCancelled: Bool { cancelled.withLock { $0 } }

    func cancel() {
        cancelled.withLock { $0 = true }
        value.cancel()
    }
}

import Foundation

// Step D7: one upload's request body, written to a temporary file so URLSession
// can stream it from disk (`upload(for:fromFile:)`): the framing, then the
// file's bytes copied a chunk at a time, then the closing boundary. Memory stays
// at one chunk; disk holds one body per upload in flight (at most 25 MiB each).
//
// Cloud files: the source is read inside an NSFileCoordinator read, so a file in
// iCloud Drive (or another File Provider folder, such as a MYBOX folder) that is
// not on this Mac yet is downloaded by the system before it is read. When that
// download fails (offline, a provider error) the file is reported as "not
// downloaded" rather than sent partly. The read runs on a queue of its own: a
// download can take a while and must not hold the main thread or a Swift
// concurrency thread. Cancelling the import cancels the coordination.

/// A request body on disk, ready to send. Delete it once it was sent.
struct DriveImportBody: Sendable {
    let file: URL
    let boundary: String
    /// The bytes of the source that went into the body (the `size` field).
    let size: Int64
}

enum DriveImportBodyWriter {
    /// Where bodies are written; emptied when an import starts.
    static var directory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("klorn-drive-import", isDirectory: true)
    }

    private static let queue = DispatchQueue(label: "ai.klorn.drive-import.read", qos: .utility, attributes: .concurrent)

    /// Remove what an earlier run left behind (a crash between write and delete).
    static func resetDirectory(_ directory: URL = directory) {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Write the body for `source`, off the calling thread, under a coordinated read.
    static func write(
        source: URL, fileName: String, parentExternalId: String?, maxFileBytes: Int64,
        directory: URL = directory
    ) async throws -> DriveImportBody {
        let coordinator = CoordinatorBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<DriveImportBody, Error>) in
                queue.async {
                    continuation.resume(with: Result {
                        try coordinatedWrite(
                            source: source, fileName: fileName, parentExternalId: parentExternalId,
                            maxFileBytes: maxFileBytes, directory: directory, coordinator: coordinator.value)
                    })
                }
            }
        } onCancel: {
            coordinator.value.cancel()
        }
    }

    private static func coordinatedWrite(
        source: URL, fileName: String, parentExternalId: String?, maxFileBytes: Int64,
        directory: URL, coordinator: NSFileCoordinator
    ) throws -> DriveImportBody {
        var coordinationError: NSError?
        var outcome: Result<DriveImportBody, Error> = .failure(DriveImportFailure.unreadable)
        coordinator.coordinate(readingItemAt: source, options: [.withoutChanges], error: &coordinationError) { url in
            outcome = Result {
                try frame(
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

    /// Framing and bytes, inside the coordinated read (the file is local by now).
    private static func frame(
        source: URL, fileName: String, parentExternalId: String?, maxFileBytes: Int64, directory: URL
    ) throws -> DriveImportBody {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let size = Int64(try input.seekToEnd())
        try input.seek(toOffset: 0)
        if let refusal = DriveImportRules.sizeVerdict(size, maxFileBytes: maxFileBytes) {
            throw refusal
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let boundary = DriveMultipart.makeBoundary()
        let bodyURL = directory.appendingPathComponent("\(UUID().uuidString).body")
        guard FileManager.default.createFile(atPath: bodyURL.path, contents: nil) else {
            throw DriveImportFailure.generic
        }
        do {
            let output = try FileHandle(forWritingTo: bodyURL)
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
/// from any thread, and it is the only call made from the cancel handler.
private final class CoordinatorBox: @unchecked Sendable {
    let value = NSFileCoordinator(filePresenter: nil)
}

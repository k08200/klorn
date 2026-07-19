import AppKit
import Foundation

/// One-click in-app update: download the notarized release zip, verify its
/// code signature (Developer ID team), swap the installed bundle, relaunch.
/// Every failure falls back to opening the release page — an update attempt
/// must never leave the user without a working app.
///
/// Translocation note: a quarantined app runs from a read-only AppTranslocation
/// mount, so `Bundle.main.bundleURL` is NOT the installed location. We resolve
/// the real install path (known locations) and swap THAT. The zip we download
/// ourselves carries no quarantine, so the first successful self-update also
/// ends translocation for good.
enum SelfUpdate {
    static let teamID = "P89M32649C"

    /// The notarized asset for a specific released version. Pure.
    nonisolated static func releaseZipURL(version: String) -> URL? {
        URL(string: "https://github.com/k08200/klorn/releases/download/desktop-v\(version)/Klorn-macos.zip")
    }

    /// Whether this process runs from Gatekeeper's read-only translocation
    /// mount (its bundle path is useless as an install target). Pure.
    nonisolated static func isTranslocated(bundlePath: String) -> Bool {
        bundlePath.contains("/AppTranslocation/")
    }

    /// Where the installed app actually lives: the running bundle when it's a
    /// real location, else the first existing known install path. Pure over
    /// the injected existence check.
    nonisolated static func installTarget(
        bundlePath: String,
        homeDirectory: String,
        exists: (String) -> Bool
    ) -> String? {
        if !isTranslocated(bundlePath: bundlePath) { return bundlePath }
        let candidates = [
            "\(homeDirectory)/Applications/Klorn.app",
            "/Applications/Klorn.app",
        ]
        return candidates.first(where: exists)
    }

    /// Shell command for the detached relauncher: wait until THIS (old)
    /// process is gone, then open the new copy. Launching before the old
    /// process exits loses the race against the single-instance guard — the
    /// new copy sees the old one, defers to it, and exits; then the old one
    /// terminates and nobody is left (observed on the first live self-update,
    /// 2026-07-20). Pure for testing.
    nonisolated static func relaunchScript(pid: Int32, appPath: String) -> String {
        let quoted = appPath.replacingOccurrences(of: "\"", with: "\\\"")
        return "while /bin/kill -0 \(pid) 2>/dev/null; do /bin/sleep 0.2; done; "
            + "/usr/bin/open \"\(quoted)\""
    }

    /// Extract the TeamIdentifier from `codesign -dv` output. Pure.
    nonisolated static func parseTeamID(_ codesignOutput: String) -> String? {
        for line in codesignOutput.split(separator: "\n") {
            if line.hasPrefix("TeamIdentifier=") {
                let value = line.dropFirst("TeamIdentifier=".count)
                return value.isEmpty || value == "not set" ? nil : String(value)
            }
        }
        return nil
    }

    enum Outcome: Equatable { case relaunching, fellBackToReleasePage(String) }

    /// Download → verify → swap → relaunch. Returns only on fallback (the
    /// success path terminates the process).
    @MainActor
    static func run(version: String) async -> Outcome {
        guard let zipURL = releaseZipURL(version: version) else {
            return fallback("bad release URL")
        }
        guard let target = installTarget(
            bundlePath: Bundle.main.bundlePath,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser.path,
            exists: { FileManager.default.fileExists(atPath: $0) })
        else {
            return fallback("install location not found")
        }

        do {
            let work = FileManager.default.temporaryDirectory
                .appendingPathComponent("klorn-update-\(version)", isDirectory: true)
            try? FileManager.default.removeItem(at: work)
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)

            // 1. Download the notarized zip (no browser → no quarantine).
            let (downloaded, response) = try await URLSession.shared.download(from: zipURL)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                return fallback("download failed")
            }
            let zipPath = work.appendingPathComponent("Klorn-macos.zip")
            try FileManager.default.moveItem(at: downloaded, to: zipPath)

            // 2. Unpack.
            guard shell("/usr/bin/ditto", ["-x", "-k", zipPath.path, work.path]).status == 0 else {
                return fallback("unpack failed")
            }
            let newApp = work.appendingPathComponent("Klorn.app")
            guard FileManager.default.fileExists(atPath: newApp.path) else {
                return fallback("zip did not contain Klorn.app")
            }

            // 3. Verify the signature really is ours before swapping anything.
            let strict = shell("/usr/bin/codesign", ["--verify", "--deep", "--strict", newApp.path])
            let info = shell("/usr/bin/codesign", ["-dv", newApp.path])
            guard strict.status == 0, parseTeamID(info.output) == teamID else {
                return fallback("signature verification failed")
            }

            // 4. Swap: keep the old bundle next to the target until the copy
            // lands, so a failed swap can restore it.
            let targetURL = URL(fileURLWithPath: target)
            let backup = targetURL.deletingLastPathComponent()
                .appendingPathComponent("Klorn.app.updating")
            try? FileManager.default.removeItem(at: backup)
            try FileManager.default.moveItem(at: targetURL, to: backup)
            do {
                guard shell("/usr/bin/ditto", [newApp.path, targetURL.path]).status == 0 else {
                    throw CocoaError(.fileWriteUnknown)
                }
            } catch {
                try? FileManager.default.moveItem(at: backup, to: targetURL)  // restore
                return fallback("swap failed")
            }
            try? FileManager.default.removeItem(at: backup)

            // 5. Relaunch AFTER this (old) process exits: a detached /bin/sh
            // waits on our PID so the new copy's single-instance guard can't
            // find us and defer. The helper is orphaned on our exit and keeps
            // running — that's the point.
            let helper = Process()
            helper.executableURL = URL(fileURLWithPath: "/bin/sh")
            helper.arguments = [
                "-c",
                Self.relaunchScript(
                    pid: ProcessInfo.processInfo.processIdentifier, appPath: targetURL.path),
            ]
            try helper.run()
            NSApp.terminate(nil)
            return .relaunching
        } catch {
            return fallback("update error: \(error.localizedDescription)")
        }
    }

    @MainActor
    private static func fallback(_ reason: String) -> Outcome {
        Log.app.warning("self-update fell back (\(reason, privacy: .public)) — opening release page")
        UpdateCheck.openReleasePage()
        return .fellBackToReleasePage(reason)
    }

    /// Run a tool, capture stdout+stderr. codesign writes to stderr.
    private static func shell(_ path: String, _ args: [String]) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return (-1, "")
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }
}

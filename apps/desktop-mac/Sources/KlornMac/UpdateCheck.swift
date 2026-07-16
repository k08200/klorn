import AppKit
import Foundation

/// Manual update check against GitHub releases. No auto-install (that's
/// Sparkle + notarization territory); this only answers "is there a newer
/// desktop build?" and opens the release page. The comparison is pure and
/// pinned by the self-check harness.
enum UpdateCheck {
    static let latestReleaseAPI =
        "https://api.github.com/repos/k08200/klorn/releases/latest"
    static let latestReleasePage = "https://github.com/k08200/klorn/releases/latest"

    enum Outcome: Equatable, Sendable {
        case updateAvailable(String)
        case upToDate
        /// Dev build or malformed tag — never claim an update we can't prove.
        case unknown
    }

    /// Compare the running version against a `desktop-vX.Y.Z` release tag.
    nonisolated static func compare(current: String, latestTag: String) -> Outcome {
        guard let latest = parse(latestTag.replacingOccurrences(of: "desktop-v", with: "")),
              latestTag.hasPrefix("desktop-v"),
              let mine = parse(current)
        else { return .unknown }
        for (a, b) in zip(mine, latest) where a != b {
            return a < b ? .updateAvailable(latest.map(String.init).joined(separator: ".")) : .upToDate
        }
        return .upToDate
    }

    private nonisolated static func parse(_ raw: String) -> [Int]? {
        let parts = raw.split(separator: ".").map(String.init)
        guard parts.count == 3 else { return nil }
        let numbers = parts.compactMap { Int($0) }
        return numbers.count == 3 ? numbers : nil
    }

    /// Fetch the latest release tag and compare. Network errors → .unknown.
    @MainActor
    static func run() async -> Outcome {
        guard let url = URL(string: latestReleaseAPI) else { return .unknown }
        var request = URLRequest(url: url)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        guard let (data, _) = try? await URLSession.shared.data(for: request) else { return .unknown }
        struct Release: Decodable { let tag_name: String }
        guard let release = try? JSONDecoder().decode(Release.self, from: data) else { return .unknown }
        return compare(current: AppInfo.version, latestTag: release.tag_name)
    }

    @MainActor
    static func openReleasePage() {
        if let url = URL(string: latestReleasePage) { NSWorkspace.shared.open(url) }
    }
}

import Foundation

/// Which bundled file the shell serves for a request path — the Swift port of
/// apps/mobile/shell/resolve-route.mjs (the reference, with the reasons). Both
/// must give the answers in apps/mobile/shell/route-cases.json
/// (apps/mobile/shell/swift-check runs them headless with swiftc).
///
/// Capacitor answers every extension-less path with index.html; the
/// packages/web static export needs /settings → settings.html and
/// /email/<id> → email/_.html (its prerendered shell), as Cloudflare's
/// _redirects does on the web. Foundation only, so swiftc can build it alone.
struct ShellRouteResolver {
    struct Redirect: Equatable {
        let from: String
        let to: String
    }

    struct Shell: Equatable {
        let prefix: String
        let target: String
    }

    struct Rules: Equatable {
        static let empty = Rules(redirects: [], shells: [])
        let redirects: [Redirect]
        let shells: [Shell]
    }

    private static func isPlainPath(_ value: Any?) -> String? {
        guard let path = value as? String, path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
        return path
    }

    /// shell-routes.json data → rules; malformed entries are dropped, nil or bad JSON is `.empty`.
    static func parse(_ data: Data?) -> Rules {
        guard let data = data,
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return .empty }
        let redirects = (raw["redirects"] as? [Any] ?? []).compactMap { entry -> Redirect? in
            guard let r = entry as? [String: Any],
                  let from = isPlainPath(r["from"]), let to = isPlainPath(r["to"]) else { return nil }
            return Redirect(from: from, to: to)
        }
        let shells = (raw["shells"] as? [Any] ?? []).compactMap { entry -> Shell? in
            guard let s = entry as? [String: Any],
                  let prefix = isPlainPath(s["prefix"]), prefix.hasSuffix("/"),
                  let target = isPlainPath(s["target"]) else { return nil }
            return Shell(prefix: prefix, target: target)
        }
        return Rules(redirects: redirects, shells: shells)
    }

    private static func redirectOf(_ path: String, _ rules: Rules) -> String? {
        rules.redirects.first { $0.from == path }?.to
    }

    private static func shellOf(_ path: String, _ rules: Rules) -> String? {
        for shell in rules.shells where path.hasPrefix(shell.prefix) {
            let rest = path.dropFirst(shell.prefix.count)
            if !rest.isEmpty && !rest.contains("/") { return shell.target }
        }
        return nil
    }

    static func resolve(_ rawPath: String, rules: Rules, exists: (String) -> Bool) -> String {
        var path = rawPath.isEmpty ? "/" : rawPath
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        if path == "/" { return "/index.html" }

        let last = path[path.index(after: path.lastIndex(of: "/")!)...]
        if last.contains(".") {
            if exists(path) || !path.hasSuffix(".txt") { return path }
            let base = String(path.dropLast(".txt".count))
            if let mapped = redirectOf(base, rules) ?? shellOf(base, rules), exists(mapped + ".txt") {
                return mapped + ".txt"
            }
            return path
        }

        let page = redirectOf(path, rules) ?? path
        if exists(page + ".html") { return page + ".html" }
        if exists(page + "/index.html") { return page + "/index.html" }
        if let shell = shellOf(page, rules), exists(shell + ".html") { return shell + ".html" }
        return exists("/404.html") ? "/404.html" : "/index.html"
    }
}

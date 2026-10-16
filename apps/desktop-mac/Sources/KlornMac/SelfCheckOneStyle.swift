import Foundation

// Self-check for the one-style rule, run by `KlornMac --self-check`. The pill
// and the expanded panel are gone (2026-10-15, LOCKED), so every view draws
// one way: the main window's. A type scan over the shipping sources fails if
// a bar, legacy or overlay style variant comes back.

enum OneStyleGuard {
    /// Variant names the retired surfaces used. Split so this file's own
    /// literals never read as a declaration.
    static let retiredVariants: Set<String> = ["b" + "ar", "leg" + "acy", "over" + "lay"]

    /// The style types and wrappers the collapse deleted.
    static let retiredTypes = [
        "Shell" + "Style", "MailRow" + "Style", "Compose" + "Style", "Modal" + "Presentation",
        "Full" + "Row", "SearchHit" + "Row", "Lane" + "Chip", "ComposePanelRender" + "Probe",
    ]

    /// `enum Name` → the case names declared directly in its body.
    static func enumCases(in source: String) -> [String: [String]] {
        guard let header = try? NSRegularExpression(pattern: #"\benum\s+(\w+)[^{]*\{"#) else { return [:] }
        let chars = Array(source)
        let ns = source as NSString
        var found: [String: [String]] = [:]
        for match in header.matches(in: source, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: match.range(at: 1))
            let open = (ns.substring(to: match.range.location + match.range.length) as String).count
            found[name, default: []] += caseNames(in: body(chars, from: open))
        }
        return found
    }

    /// The text between an opening brace (already consumed) and its match,
    /// with nested braces blanked so only the enum's own cases remain.
    private static func body(_ chars: [Character], from start: Int) -> String {
        var depth = 1
        var out = ""
        var index = start
        while index < chars.count, depth > 0 {
            let char = chars[index]
            if char == "{" { depth += 1 }
            if char == "}" { depth -= 1 }
            if depth == 1, char != "}" { out.append(char) }
            if depth == 0 { break }
            index += 1
        }
        return out
    }

    /// `case a, b(Int), c = "x"` → [a, b, c]. Switch labels (`case .a:`)
    /// never match: they start with a dot.
    private static func caseNames(in body: String) -> [String] {
        guard let decl = try? NSRegularExpression(pattern: #"(?m)^\s*(?:indirect\s+)?case\s+([A-Za-z_][^\n:]*)$"#)
        else { return [] }
        let ns = body as NSString
        return decl.matches(in: body, range: NSRange(location: 0, length: ns.length)).flatMap { match in
            ns.substring(with: match.range(at: 1))
                .split(separator: ",")
                .compactMap { part in
                    part.trimmingCharacters(in: .whitespaces)
                        .split(whereSeparator: { "(= ".contains($0) }).first.map(String.init)
                }
        }
    }

    /// Every offense in one file's source.
    static func offenses(in source: String) -> [String] {
        var out: [String] = []
        for (name, cases) in enumCases(in: source) {
            for retired in cases where retiredVariants.contains(retired) {
                out.append("enum \(name) case \(retired)")
            }
        }
        for retired in retiredVariants.sorted() {
            let pattern = #"\bstatic\s+(?:let|var)\s+"# + retired + #"\b"#
            if source.range(of: pattern, options: .regularExpression) != nil {
                out.append("static variant .\(retired)")
            }
        }
        for type in retiredTypes where source.range(of: #"\b"# + type + #"\b"#, options: .regularExpression) != nil {
            out.append("retired type \(type)")
        }
        return out
    }
}

func oneStyleSelfChecks(sourceDir: URL) -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    // The guard's own rules first, on fixtures.
    let flagged = [
        "enum Look: Sendable {\n    case " + "bar\n    case window\n}",
        "enum Look { case window, " + "legacy }",
        "enum Look { case " + "overlay, sheet }",
        "struct M {\n    static let " + "bar = M()\n}",
    ]
    let clean = [
        "enum Look { case window\n    var x: Int { switch self { case .window: 1 } } }",
        "enum Tier: String { case push, queue = \"QUEUE\", info(Int) }",
        "struct M { static let window = M() }\nlet bars = 1  // the " + "bar's old look",
        "WindowLaneChip(tier: .push)",
    ]
    results.append((
        "the one-style guard flags a bar, legacy or overlay variant and passes the rest",
        flagged.allSatisfy { !OneStyleGuard.offenses(in: $0).isEmpty }
            && clean.allSatisfy { OneStyleGuard.offenses(in: $0).isEmpty }
            && OneStyleGuard.enumCases(in: "enum A { case x, y(Int) }\nenum B { case z }")
                == ["A": ["x", "y"], "B": ["z"]]))

    let shipping = swiftSources(under: sourceDir).filter { !$0.lastPathComponent.hasPrefix("SelfCheck") }
    var offenders: [String] = []
    for url in shipping {
        let source = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        offenders += OneStyleGuard.offenses(in: source).map { "\(url.lastPathComponent): \($0)" }
    }
    print("    one-style guard: \(shipping.count) files, \(offenders.count) offenses")
    for offense in offenders { print("      \(offense)") }
    results.append(("the one-style guard reads the shipping sources", shipping.count >= 50))
    results.append(("no view keeps a bar, legacy or overlay style variant", offenders.isEmpty))
    return results
}

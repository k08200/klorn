// Runs ios/App/App/ShellRouteResolver.swift against shell/route-cases.json,
// headless (no Xcode project, no simulator):
//   swiftc -o /tmp/shell-check apps/mobile/ios/App/App/ShellRouteResolver.swift \
//     apps/mobile/shell/swift-check/main.swift && /tmp/shell-check apps/mobile/shell/route-cases.json
import Foundation

guard CommandLine.arguments.count == 2,
      let data = FileManager.default.contents(atPath: CommandLine.arguments[1]),
      let vectors = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    FileHandle.standardError.write("usage: shell-check <route-cases.json>\n".data(using: .utf8)!)
    exit(2)
}

var failures = 0

func check(_ cases: [[String: String]], _ rules: ShellRouteResolver.Rules, _ files: [String]) {
    let set = Set(files)
    for c in cases {
        let path = c["path"] ?? ""
        let got = ShellRouteResolver.resolve(path, rules: rules) { set.contains($0) }
        if got != c["expect"] {
            failures += 1
            print("✗ \"\(path)\": expected \(c["expect"] ?? "?"), got \(got)")
        }
    }
}

let rulesData = try JSONSerialization.data(withJSONObject: vectors["rules"] ?? [:])
check(vectors["cases"] as? [[String: String]] ?? [], ShellRouteResolver.parse(rulesData), vectors["files"] as? [String] ?? [])
let spa = vectors["spaCases"] as? [String: Any] ?? [:]
check(spa["cases"] as? [[String: String]] ?? [], ShellRouteResolver.parse(nil), spa["files"] as? [String] ?? [])
let malformed = ShellRouteResolver.parse(#"{"redirects":[{"from":"a","to":"/b"}],"shells":[{"prefix":"/y","target":"/y/_"}]}"#.data(using: .utf8))
if malformed != .empty { failures += 1; print("✗ malformed rules were not dropped") }

if failures > 0 { exit(1) }
print("✓ ShellRouteResolver.swift passes route-cases.json")

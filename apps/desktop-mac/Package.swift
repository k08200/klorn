// swift-tools-version: 6.0
import PackageDescription

// Klorn — native macOS app (SwiftUI). A real native client of the Klorn
// firewall API, not a webview wrapper. Built as a Swift Package so it stays
// text-based and reproducible in this OSS repo; open Package.swift in Xcode
// for a signed distributable .app, or `swift run` for development.
//
// Tests run via `swift run KlornMac --self-check` (a plain-Swift harness) so
// they work on a Command Line Tools toolchain, which ships no XCTest/Testing.
// A full XCTest suite can be added when building under Xcode/CI.
let package = Package(
    name: "KlornMac",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "KlornMac",
            path: "Sources/KlornMac"
        ),
    ]
)

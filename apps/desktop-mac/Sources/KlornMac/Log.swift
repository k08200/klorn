import os

/// App loggers. Raw errors/response bodies go here (privacy: .private) — never
/// into user-facing strings — so the UI shows generic messages while debugging
/// detail stays in the unified log / crash reports.
enum Log {
    static let net = Logger(subsystem: "ai.klorn.desktop", category: "net")
    static let app = Logger(subsystem: "ai.klorn.desktop", category: "app")
}

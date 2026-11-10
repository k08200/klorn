import AppKit

/// Screen-fit rule shared by the app's windows (main, compose). Pure, so the self-check pins them without a window server.
enum WindowGeometry {
    /// Shrink `frame` to fit `visible`, then shift it fully on-screen
    /// (top-priority: the title bar at the top must stay reachable — the
    /// clipping lessons, 2026-08-18/20).
    nonisolated static func clamped(_ frame: NSRect, into visible: NSRect) -> NSRect {
        var f = frame
        f.size.width = min(f.width, visible.width)
        f.size.height = min(f.height, visible.height)
        if f.maxY > visible.maxY { f.origin.y = visible.maxY - f.height }
        if f.minY < visible.minY { f.origin.y = visible.minY }
        if f.maxX > visible.maxX { f.origin.x = visible.maxX - f.width }
        if f.minX < visible.minX { f.origin.x = visible.minX }
        return f
    }
}

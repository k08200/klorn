import SwiftUI

/// Where a shared view is drawn. The bar's surfaces keep the look they
/// shipped with until `BarState.full` is deleted (M8); the main window
/// (`macMainWindow`) wears the design system (productization plan §2).
/// Every shared view defaults to `.bar`, so the bar never changes by accident.
enum ShellStyle: Sendable {
    case bar
    case window
}

// Design tokens added for the main window (productization plan §2, M7).
// Pure values first, so the self-check can do contrast math without AppKit.
extension Theme {
    // MARK: Lane chip
    /// The lane wash under a chip's text.
    static let chipWashOpacity = 0.13

    /// Chip text for a lane. One step deeper than `laneComponents` in light
    /// (Tailwind 800/900-level, the web's chip inks), one step lighter in
    /// dark where the 400 hue needed it, so the text clears 4.5:1 on its own
    /// 13% wash over the canvas, the panel, a raised card, a hovered row and
    /// a selected row. The self-check pins every pair.
    static func chipInkComponents(_ tier: Tier, dark: Bool) -> RGBA {
        switch (tier, dark) {
        case (.push, false): hex(0x9F1239)  // rose-800
        case (.push, true): hex(0xFDA4AF)  // rose-300
        case (.meeting, false): hex(0x4338CA)  // indigo-700
        case (.meeting, true): hex(0xA5B4FC)  // indigo-300
        case (.queue, false): hex(0x92400E)  // amber-800
        case (.queue, true): hex(0xFBBF24)  // amber-400
        case (.info, false): hex(0x155E75)  // cyan-800
        case (.info, true): hex(0x22D3EE)  // cyan-400
        case (.silent, false): hex(0x57534E)  // stone-600
        case (.silent, true): hex(0xA8A29E)  // stone-400
        }
    }

    static func chipInk(_ tier: Tier) -> Color {
        dyn(light: chipInkComponents(tier, dark: false), dark: chipInkComponents(tier, dark: true))
    }

    // MARK: Status inks
    // `success` / `warning` / `danger` are AppKit system colors: right for a
    // dot, 2–3:1 as text on the light canvas. These carry a sentence.
    static let warningInkLight = hex(0x92400E)
    static let warningInkDark = hex(0xFBBF24)
    static let dangerInkLight = hex(0xB91C1C)
    static let dangerInkDark = hex(0xFCA5A5)
    static let successInkLight = hex(0x166534)
    static let successInkDark = hex(0x86EFAC)
    static let warningInk = dyn(light: warningInkLight, dark: warningInkDark)
    static let dangerInk = dyn(light: dangerInkLight, dark: dangerInkDark)
    static let successInk = dyn(light: successInkLight, dark: successInkDark)

    // MARK: Surfaces as pure values
    /// Source-over of a translucent color on an opaque one.
    static func composite(_ top: RGBA, over bottom: RGBA) -> RGBA {
        let a = top.a
        return (top.r * a + bottom.r * (1 - a), top.g * a + bottom.g * (1 - a),
                top.b * a + bottom.b * (1 - a), 1)
    }

    /// Every opaque surface a chip or a status line sits on in the main
    /// window, by name: the canvas, a panel on it, a raised card on the
    /// panel, a hovered row and a selected row on the canvas.
    static func windowSurfaces(dark: Bool) -> [(name: String, color: RGBA)] {
        let canvas = dark ? bgDark : bgLight
        let panel = composite(dark ? panelDark : panelLight, over: canvas)
        let raised = composite(dark ? surfaceRaisedDark : surfaceRaisedLight, over: panel)
        let hover = composite(dark ? surfaceHoverDark : surfaceHoverLight, over: canvas)
        var accent = accentComponents
        accent.a = surfaceSelectedOpacity
        return [
            ("canvas", canvas), ("panel", panel), ("raised card", raised),
            ("hovered row", hover), ("selected row", composite(accent, over: canvas)),
        ]
    }

    /// WCAG relative luminance and contrast ratio on opaque sRGB values.
    static func luminance(_ c: RGBA) -> Double {
        func lin(_ v: Double) -> Double {
            v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
    }

    static func contrast(_ a: RGBA, _ b: RGBA) -> Double {
        let (x, y) = (luminance(a) + 0.05, luminance(b) + 0.05)
        return max(x, y) / min(x, y)
    }

    /// A lane chip's text against its own wash on `surface`.
    static func chipContrast(_ tier: Tier, dark: Bool, on surface: RGBA) -> Double {
        var wash = chipInkComponents(tier, dark: dark)
        wash.a = chipWashOpacity
        return contrast(chipInkComponents(tier, dark: dark), composite(wash, over: surface))
    }

    // MARK: Elevation (L0 canvas, L1 hairline, L2 popovers, L3 sheets)
    enum Elevation {
        case l2
        case l3

        var opacity: Double { self == .l2 ? 0.12 : 0.18 }
        /// SwiftUI's shadow radius is half the CSS blur (24 / 48).
        var radius: CGFloat { self == .l2 ? 12 : 24 }
        var y: CGFloat { self == .l2 ? 8 : 24 }
    }

    // MARK: Motion (120ms state, 200ms enter, 160ms exit)
    enum Motion {
        static let state = 0.12
        static let enter = 0.20
        static let exit = 0.16
        static let stateChange = Animation.easeOut(duration: state)
    }

    /// A 1pt rule, and the optical nudge that seats small text on a baseline.
    static let hairline: CGFloat = 1
    /// The main window's list row floor (plan §2: 52 on desktop).
    static let rowHeight: CGFloat = 52
}

extension Theme.Typo {
    /// The glyph over an empty or failed state. An icon, not text.
    static let stateGlyph = Font.system(size: 28, weight: .light)
    /// SourceBadge monogram in its 20pt tile (G, M, N, iC). A glyph: the
    /// account's name is always beside it as text.
    static let monogram = Font.system(size: 10, weight: .bold, design: .rounded)
    /// The four-letter monogram (IMAP) in the same tile.
    static let monogramTight = Font.system(size: 8, weight: .bold, design: .rounded)
}

extension View {
    /// The plan's shadow for a floating layer.
    func elevation(_ level: Theme.Elevation) -> some View {
        shadow(color: Color.black.opacity(level.opacity), radius: level.radius, y: level.y)
    }
}

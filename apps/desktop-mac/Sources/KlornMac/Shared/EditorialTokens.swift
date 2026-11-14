import SwiftUI

// Tokens for the editorial Today and the account-tinted window chrome (M1
// dark / M2 light, founder decision 2026-11-13). Pure components first, so
// the self-check measures contrast without AppKit; the Colors are built from
// them. Values: ~/klorn-shots/decide-board/gen_m1e.py (DEFAULTS["b"], C).
extension Theme {
    // MARK: Content card and raised card
    static func todayCardComponents(dark: Bool) -> RGBA { dark ? hex(0x161618) : hex(0xFFFFFF) }
    static func todayRaisedComponents(dark: Bool) -> RGBA { dark ? hex(0x202023) : hex(0xF6F4F2) }
    /// The floating content card the sections sit on.
    static let todayCard = dyn(light: todayCardComponents(dark: false), dark: todayCardComponents(dark: true))
    /// A raised card on it (a PUSH card).
    static let todayRaised = dyn(
        light: todayRaisedComponents(dark: false), dark: todayRaisedComponents(dark: true))

    // MARK: Text on the card
    /// t1 / t2 / t3. Measured on the card, a raised card and a chip by the
    /// self-check (≥4.5:1). t3 is a step lighter (dark) / darker (light)
    /// than the mockup's #86868D / #77726C: those were 4.45 on #202023 and
    /// 4.3 on #F6F4F2.
    static func todayInkComponents(_ level: Int, dark: Bool) -> RGBA {
        switch (level, dark) {
        case (1, true): hex(0xEDEDEF)
        case (2, true): hex(0xAEAEB4)
        case (_, true): hex(0x8C8C93)
        case (1, false): hex(0x1C1A18)
        case (2, false): hex(0x57534E)
        default: hex(0x6E6964)
        }
    }

    static let todayInk1 = dyn(light: todayInkComponents(1, dark: false), dark: todayInkComponents(1, dark: true))
    static let todayInk2 = dyn(light: todayInkComponents(2, dark: false), dark: todayInkComponents(2, dark: true))
    static let todayInk3 = dyn(light: todayInkComponents(3, dark: false), dark: todayInkComponents(3, dark: true))

    /// The PUSH kicker on a card.
    static func todayPushInkComponents(dark: Bool) -> RGBA { dark ? hex(0xF2545B) : hex(0xC8323B) }
    static let todayPushInk = dyn(
        light: todayPushInkComponents(dark: false), dark: todayPushInkComponents(dark: true))

    // MARK: Fills on the card
    /// The reason chip and quiet fills: white 8% (dark) / black 5% (light).
    static func todayChipComponents(dark: Bool) -> RGBA { dark ? (1, 1, 1, 0.08) : (0, 0, 0, 0.05) }
    static let todayChip = dyn(light: todayChipComponents(dark: false), dark: todayChipComponents(dark: true))
    /// The filled card button ("Reply"): white 10% / black 6%.
    static let todayButtonFill = dyn(light: (0, 0, 0, 0.06), dark: (1, 1, 1, 0.10))
    /// Row rules inside the card: white 6% / black 7%.
    static let todayLine = dyn(light: (0, 0, 0, 0.07), dark: (1, 1, 1, 0.06))
    /// A raised card's inner top highlight: white 5% (dark only).
    static let todayHighlight = dyn(light: (1, 1, 1, 0), dark: (1, 1, 1, 0.05))
    /// The content card's shadow: black 45% (dark) / 10% (light).
    static let todayCardShadow = dyn(light: (0, 0, 0, 0.10), dark: (0, 0, 0, 0.45))

    // MARK: Window chrome
    /// The chrome's three gradient stops (top, middle, bottom). nil identity
    /// = all accounts: espresso. An account tints the chrome with a deep,
    /// desaturated tone of its own hue (S 35%, L 14–16% dark; S 30%,
    /// L 90–92% light); its bright color stays on dots and rings.
    static func chromeStops(identity: RGBA?, dark: Bool) -> [RGBA] {
        guard let identity else {
            return dark
                ? [hex(0x2B211C), hex(0x261D18), hex(0x2D221C)]
                : [hex(0xEDE5DE), hex(0xE8DFD7), hex(0xEBE3DB)]
        }
        let hue = hsl(identity).h
        let (saturation, lightness): (Double, [Double]) = dark
            ? (0.35, [0.150, 0.135, 0.160]) : (0.30, [0.915, 0.900, 0.910])
        return lightness.map { rgb(h: hue, s: saturation, l: $0) }
    }

    static func chromeGradient(identity: RGBA?) -> LinearGradient {
        let light = chromeStops(identity: identity, dark: false)
        let dark = chromeStops(identity: identity, dark: true)
        return LinearGradient(
            stops: zip(light, dark).enumerated().map { index, pair in
                Gradient.Stop(color: dyn(light: pair.0, dark: pair.1), location: [0, 0.6, 1][index])
            },
            startPoint: .top, endPoint: .bottom)
    }

    /// Sidebar text on the chrome: white 92% / 66% (dark), black 88% / 62%
    /// (light). The mockup's 50% measured 3.5:1 (dark, on the selected pill
    /// over the lightest account tint) and 3.6:1 (light espresso); the
    /// self-check holds every tint and the pill at 4.5:1.
    static func sidebarInkComponents(_ level: Int, dark: Bool) -> RGBA {
        let alpha = level == 1 ? (dark ? 0.92 : 0.88) : (dark ? 0.66 : 0.62)
        return dark ? (1, 1, 1, alpha) : (0, 0, 0, alpha)
    }

    static let sidebarInk = dyn(light: sidebarInkComponents(1, dark: false), dark: sidebarInkComponents(1, dark: true))
    static let sidebarInkDim = dyn(
        light: sidebarInkComponents(2, dark: false), dark: sidebarInkComponents(2, dark: true))
    /// The selected sidebar row: white 12% / black 7%.
    static func sidebarPillComponents(dark: Bool) -> RGBA { dark ? (1, 1, 1, 0.12) : (0, 0, 0, 0.07) }
    static let sidebarPill = dyn(light: sidebarPillComponents(dark: false), dark: sidebarPillComponents(dark: true))
    static let sidebarHover = dyn(light: (0, 0, 0, 0.04), dark: (1, 1, 1, 0.06))

    // MARK: Faces
    /// A monogram's muted fill: the sender's hashed hue at S 30%, L 34% —
    /// dark enough that the white initials clear 4.5:1 on every hue.
    static func avatarFillComponents(hue: Double) -> RGBA { rgb(h: hue, s: 0.30, l: 0.34) }

    /// Initials on a face.
    static let onAvatar = dyn(light: (1, 1, 1, 1), dark: (1, 1, 1, 1))

    static func color(_ c: RGBA) -> Color { dyn(light: c, dark: c) }

    // MARK: HSL
    static func hsl(_ c: RGBA) -> (h: Double, s: Double, l: Double) {
        let maxV = max(c.r, c.g, c.b)
        let minV = min(c.r, c.g, c.b)
        let l = (maxV + minV) / 2
        let d = maxV - minV
        guard d > 0 else { return (0, 0, l) }
        let s = l > 0.5 ? d / (2 - maxV - minV) : d / (maxV + minV)
        var h: Double
        switch maxV {
        case c.r: h = (c.g - c.b) / d + (c.g < c.b ? 6 : 0)
        case c.g: h = (c.b - c.r) / d + 2
        default: h = (c.r - c.g) / d + 4
        }
        h *= 60
        return (h, s, l)
    }

    static func rgb(h: Double, s: Double, l: Double) -> RGBA {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        let (r, g, b): (Double, Double, Double) = switch hp {
        case ..<1: (c, x, 0)
        case ..<2: (x, c, 0)
        case ..<3: (0, c, x)
        case ..<4: (0, x, c)
        case ..<5: (x, 0, c)
        default: (c, 0, x)
        }
        let m = l - c / 2
        return (r + m, g + m, b + m, 1)
    }
}

extension Theme.Typo {
    /// Editorial Today type (gen_m1e.py): the headline is `page` (28).
    static let todayCaps = Font.system(size: 12, weight: .semibold)
    static let cardTitle = Font.system(size: 17, weight: .semibold)
    static let cardSender = Font.system(size: 13, weight: .semibold)
    static let cardTime = Font.system(size: 11.5)
    static let cardKicker = Font.system(size: 10.5, weight: .bold)
    static let rowSender = Font.system(size: 13, weight: .medium)
    static let reasonChip = Font.system(size: 11.5)
    static let scopeLabel = Font.system(size: 12)
    static let sidebarRow = Font.system(size: 12.5)

    /// Initials inside a face of `diameter` points.
    static func avatarMonogram(_ diameter: CGFloat) -> Font {
        Font.system(size: (diameter * 0.38).rounded(), weight: .semibold)
    }
}

/// Letter spacing for the caps lines (0.1em at 12pt) and the kicker (0.08em).
enum TodayTracking {
    static let caps: CGFloat = 1.2
    static let kicker: CGFloat = 0.84
}

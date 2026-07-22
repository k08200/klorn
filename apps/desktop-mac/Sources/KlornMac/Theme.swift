import SwiftUI

enum Theme {
    /// Canvas — web v2 `#f4f8fc`.
    static let bg = Color(red: 0.957, green: 0.973, blue: 0.988)
    /// The one interaction accent — CTAs, focus, selection, gauge. Everything
    /// "choose me / chosen" speaks in this; the brand marks themselves are B&W.
    /// Web v2 sky-500 `#0ea5e9`.
    static let accent = Color(red: 0.055, green: 0.647, blue: 0.914)
    /// Deep end of the accent gradient (gauge fill etc.) — sky-600 `#0284c7`.
    static let accentDeep = Color(red: 0.008, green: 0.518, blue: 0.780)
    /// slate-200-grade hairline on the white glass panel.
    static let line = Color.black.opacity(0.08)

    /// The top bar is always a LIGHT floating surface regardless of system
    /// appearance, so its text uses explicit slate tones (not semantic colors).
    static let panel = Color.white.opacity(panelDefaultOpacity)
    static let panelDefaultOpacity = 0.92

    /// Panel fill opacity: fully opaque when the user asked to reduce transparency
    /// (the 8% see-through can drop contrast over a busy backdrop), else the
    /// translucent default. Pure for testing.
    static func panelOpacity(reduceTransparency: Bool) -> Double {
        reduceTransparency ? 1.0 : panelDefaultOpacity
    }
    /// slate-900 `#0f172a`.
    static let text = Color(red: 0.059, green: 0.090, blue: 0.165)
    /// slate-500 `#64748b`.
    static let textDim = Color(red: 0.392, green: 0.455, blue: 0.545)

    /// Input-field boundary. `line` (black@0.08 ≈ 1.2:1) is fine for decorative
    /// dividers but fails WCAG 1.4.11 (≥3:1) for a control boundary; 0.35 ≈ 3:1
    /// on the white panel. Use only where a control edge must be perceivable.
    static let field = Color.black.opacity(0.35)

    /// The web engagement graph's "you engage with this sender" pink — reused by
    /// the reading pane's learned-engagement chip so desktop matches the web signal.
    static let engage = Color(red: 0.96, green: 0.45, blue: 0.71)

    /// Per-tier signal palette — semantic hues kept from the dark system, with
    /// QUEUE/AUTO nudged darker so the dots stay perceivable on the white
    /// panel: warm signal red, amber-600, cool slate, calm signal blue-500.
    static func tint(_ tier: Tier) -> Color {
        switch tier {
        case .push: Color(red: 1.0, green: 0.30, blue: 0.34)
        case .queue: Color(red: 0.851, green: 0.467, blue: 0.024)
        case .silent: Color(red: 0.49, green: 0.53, blue: 0.59)
        case .auto: Color(red: 0.231, green: 0.510, blue: 0.965)
        }
    }

    /// Navy-tinted panel shadow — web v2 `rgba(2,60,110,0.22)`. One shadow
    /// color for every floating light surface.
    static let panelShadow = Color(red: 0.008, green: 0.235, blue: 0.431).opacity(0.22)

    /// White glass tint, layered OVER the real blur material — a faint cool
    /// sky cast at the bottom keeps the surface from reading as flat paper.
    /// Opacity applied by the caller (reduce-transparency mode raises it to
    /// near-solid, where the blur behind barely shows).
    static func panelGradient(opacity: Double) -> LinearGradient {
        LinearGradient(
            colors: [
                Color.white.opacity(opacity * 0.99),
                Color(red: 0.97, green: 0.98, blue: 0.995).opacity(opacity),
            ],
            startPoint: .top, endPoint: .bottom)
    }

    /// Glass tint opacity: lighter than the old solid panel so the real blur
    /// shows through; near-solid when the user asked to reduce transparency.
    static func glassTintOpacity(reduceTransparency: Bool) -> Double {
        reduceTransparency ? 0.98 : 0.72
    }

    // MARK: Surface ladder (design pass 2026-07-20)
    // One opacity scale for every interactive rest→hover→selected state, so
    // "how raised is this?" reads consistently across the app. Never invent
    // ad-hoc `Color.white.opacity(…)` fills in views — pick a rung.
    static let surfaceRaised = Color.black.opacity(0.04)   // cards, chips at rest
    static let surfaceHover = Color.black.opacity(0.07)    // pointer feedback
    /// Selection speaks in the accent — tinted fill (the accent bar still
    /// carries the hard edge, so selection is never color-alone).
    static let surfaceSelected = accent.opacity(0.12)

    // MARK: Spacing (4pt grid)
    // s2/s3 within a control, s4 between controls, s6 between sections.
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s6: CGFloat = 24
}

/// Real macOS blur behind the panel — the difference between "a white
/// rectangle" and "glass floating over your desk". `.popover` is a light
/// system material; `.behindWindow` samples whatever is under the panel. The
/// white tint gradient layers on top of this. The forced `.aqua` appearance
/// keeps the glass light even when the system is in dark mode — the panel is
/// always a light surface, matching the web v2 theme.
///
/// The blur region does NOT follow SwiftUI clipShape (the effect view's
/// backdrop is masked by AppKit, not the layer tree) — without `maskImage`
/// the glass bleeds square past the rounded corner (the corner artifact,
/// screenshot 2026-07-20). A stretchable rounded-rect mask fixes it.
struct GlassMaterial: NSViewRepresentable {
    var cornerRadius: CGFloat

    func makeNSView(context _: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.appearance = NSAppearance(named: .aqua)
        view.material = .popover
        view.blendingMode = .behindWindow
        view.state = .active
        view.maskImage = .roundedCornerMask(radius: cornerRadius)
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context _: Context) {
        view.maskImage = .roundedCornerMask(radius: cornerRadius)
    }
}

extension NSImage {
    /// A stretchable rounded-rect mask for NSVisualEffectView.maskImage.
    ///
    /// capInsets must sum to LESS than the smallest dimension being masked. A
    /// true capsule view is exactly radius×2 tall, so full-radius caps are
    /// degenerate there (52pt pill vs 53px mask image → the mask fails and the
    /// square blur backdrop bleeds out as a light corner line — dogfood zoom
    /// 2026-07-20). Half-point caps keep the stretch valid for every surface.
    static func roundedCornerMask(radius: CGFloat) -> NSImage {
        let cap = radius - 0.5
        let edge = cap * 2 + 1
        let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        image.capInsets = NSEdgeInsets(top: cap, left: cap, bottom: cap, right: cap)
        image.resizingMode = .stretch
        return image
    }
}

/// The Light Glass surface, as ONE reusable treatment: masked system blur,
/// white tint, top-edge light, hairline border, navy-tinted drop shadow. The
/// top bar, the PushCard, and the MeetingCard all wear exactly this — one
/// glass, everywhere.
struct GlassPanel: ViewModifier {
    var cornerRadius: CGFloat
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        content
            .background {
                ZStack {
                    GlassMaterial(cornerRadius: cornerRadius)
                    Theme.panelGradient(
                        opacity: Theme.glassTintOpacity(reduceTransparency: reduceTransparency))
                    LinearGradient(
                        colors: [Color.white.opacity(0.9), .clear],
                        startPoint: .top, endPoint: .center)
                        .frame(height: 1.5, alignment: .top)
                        .frame(maxHeight: .infinity, alignment: .top)
                }
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
                .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(Theme.line))
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .shadow(color: Theme.panelShadow, radius: 24, y: 8)
    }
}

extension View {
    func glassPanel(cornerRadius: CGFloat) -> some View {
        modifier(GlassPanel(cornerRadius: cornerRadius))
    }
}

extension NSPanel {
    /// Round the WINDOW itself, not just the SwiftUI content: clip the content
    /// view's layer and re-derive the window shadow. Without this the shadow
    /// rim follows the square window frame and pokes out past the glass corner
    /// (the corner-hairline artifact, dogfood zoom 2026-07-20). Call after
    /// every contentView swap or frame change.
    func applyGlassShape(cornerRadius: CGFloat) {
        guard let view = contentView else { return }
        view.wantsLayer = true
        view.layer?.cornerRadius = cornerRadius
        view.layer?.masksToBounds = true
        invalidateShadow()
    }
}

/// Dim at rest, full text on hover — the standard treatment for every
/// secondary icon/text control (header buttons, row utilities). One modifier
/// so "quiet until you reach for it" is a property of the system, not a
/// per-view accident.
struct HoverDim: ViewModifier {
    @State private var hovering = false
    func body(content: Content) -> some View {
        content
            .foregroundStyle(hovering ? Theme.text : Theme.textDim)
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

extension View {
    func hoverDim() -> some View { modifier(HoverDim()) }
}

/// The one primary-CTA treatment — web `glow-primary` equivalent: sky
/// accent→accentDeep vertical gradient, white text, soft accent shadow.
/// Every "the one thing to do here" button wears this; secondary actions
/// stay `.bordered`/plain.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(
                LinearGradient(
                    colors: [Theme.accent, Theme.accentDeep],
                    startPoint: .top, endPoint: .bottom),
                in: RoundedRectangle(cornerRadius: 7))
            .shadow(color: Theme.accent.opacity(isEnabled ? 0.35 : 0), radius: 6, y: 2)
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1.0) : 0.45)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

/// The standard quiet empty/guidance state: dim icon, one calm line, and an
/// optional hint. Every "nothing here" moment uses this instead of a bare
/// dim string, so emptiness reads as designed rather than unfinished.
struct EmptyState: View {
    let icon: String
    let title: String
    var hint: String? = nil

    var body: some View {
        VStack(spacing: Theme.s3) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(Theme.textDim.opacity(0.7))
                .accessibilityHidden(true)
            Text(title).font(.callout).foregroundStyle(Theme.textDim)
            if let hint {
                Text(hint).font(.caption).foregroundStyle(Theme.textDim.opacity(0.7))
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// Compact per-tier count chip for the queue header.
struct TierBadge: View {
    let tier: Tier
    let count: Int

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Theme.tint(tier)).frame(width: 7, height: 7)
            Text(tier.label).font(.caption).foregroundStyle(.secondary)
            Text("\(count)").font(.caption.monospacedDigit().weight(.semibold))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Theme.surfaceRaised, in: Capsule())
    }
}

/// One classified item in the decision queue.
struct FirewallRow: View {
    let item: FirewallItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(Theme.tint(item.tier)).frame(width: 8, height: 8).padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.email?.subject ?? item.title)
                    .font(.body.weight(.medium)).lineLimit(1)
                if let from = item.email?.from, !from.isEmpty {
                    Text(from).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                if let reason = item.tierReason, !reason.isEmpty {
                    Text(reason).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            Spacer()
            if item.hashStale == true {
                Text("re-classifying").font(.caption2).foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 4)
        .listRowBackground(Color.clear)
    }
}

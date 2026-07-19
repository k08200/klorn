import SwiftUI

enum Theme {
    static let bg = Color(red: 0.043, green: 0.043, blue: 0.059)
    /// Klorn amber — a designed warm signal, not system orange. Everything
    /// "Klorn is speaking" (logo ring, CTAs, focus, selection bar) uses this.
    static let accent = Color(red: 1.0, green: 0.63, blue: 0.20)
    static let line = Color.white.opacity(0.08)

    /// The top bar is always a dark floating surface regardless of system
    /// appearance, so its text uses explicit light tones (not semantic colors).
    static let panel = Color.black.opacity(panelDefaultOpacity)
    static let panelDefaultOpacity = 0.92

    /// Panel fill opacity: fully opaque when the user asked to reduce transparency
    /// (the 8% see-through can drop contrast over a busy backdrop), else the
    /// translucent default. Pure for testing.
    static func panelOpacity(reduceTransparency: Bool) -> Double {
        reduceTransparency ? 1.0 : panelDefaultOpacity
    }
    static let text = Color.white
    static let textDim = Color.white.opacity(0.55)

    /// Input-field boundary. `line` (white@0.08 ≈ 1.2:1) is fine for decorative
    /// dividers but fails WCAG 1.4.11 (≥3:1) for a control boundary; 0.40 ≈ 3:1
    /// on the dark panel. Use only where a control edge must be perceivable.
    static let field = Color.white.opacity(0.40)

    /// The web engagement graph's "you engage with this sender" pink — reused by
    /// the reading pane's learned-engagement chip so desktop matches the web signal.
    static let engage = Color(red: 0.96, green: 0.45, blue: 0.71)

    /// Per-tier signal palette — designed hues with matched brightness on the
    /// dark panel (system .red/.orange/.gray/.blue read as defaults): warm
    /// signal red, Klorn-adjacent amber, cool slate, calm signal blue.
    static func tint(_ tier: Tier) -> Color {
        switch tier {
        case .push: Color(red: 1.0, green: 0.30, blue: 0.34)
        case .queue: Color(red: 1.0, green: 0.69, blue: 0.26)
        case .silent: Color(red: 0.49, green: 0.53, blue: 0.59)
        case .auto: Color(red: 0.30, green: 0.62, blue: 1.0)
        }
    }

    /// Warm-graphite glass tint, layered OVER the real blur material: amber
    /// bleeds faintly into the top of the surface so even the background is
    /// unmistakably Klorn. Opacity applied by the caller (reduce-transparency
    /// mode raises it to near-solid, where the blur behind barely shows).
    static func panelGradient(opacity: Double) -> LinearGradient {
        LinearGradient(
            colors: [
                Color(red: 0.115, green: 0.095, blue: 0.075).opacity(opacity),
                Color(red: 0.050, green: 0.046, blue: 0.050).opacity(opacity),
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
    static let surfaceRaised = Color.white.opacity(0.05)   // cards, chips at rest
    static let surfaceHover = Color.white.opacity(0.09)    // pointer feedback
    /// Selection is WARM: when Klorn marks something as chosen, the brand
    /// speaks — amber-tinted fill (the accent bar still carries the hard edge,
    /// so selection is never color-alone).
    static let surfaceSelected = accent.opacity(0.16)

    // MARK: Spacing (4pt grid)
    // s2/s3 within a control, s4 between controls, s6 between sections.
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s6: CGFloat = 24
}

/// Real macOS blur behind the panel — the difference between "a dark
/// rectangle" and "glass floating over your desk". `.hudWindow` is the
/// system's heads-up material; `.behindWindow` samples whatever is under the
/// panel. The warm tint gradient layers on top of this.
///
/// The blur region does NOT follow SwiftUI clipShape (the effect view's
/// backdrop is masked by AppKit, not the layer tree) — without `maskImage`
/// the glass bleeds square past the rounded corner (the corner artifact,
/// screenshot 2026-07-20). A stretchable rounded-rect mask fixes it.
struct GlassMaterial: NSViewRepresentable {
    var cornerRadius: CGFloat

    func makeNSView(context _: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
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

/// The Warm Glass surface, as ONE reusable treatment: masked system blur,
/// warm-graphite tint, top-edge light, hairline border, drop shadow. The top
/// bar, the PushCard, and the MeetingCard all wear exactly this — one glass,
/// everywhere.
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
                        colors: [Color.white.opacity(0.10), .clear],
                        startPoint: .top, endPoint: .center)
                        .frame(height: 1.5, alignment: .top)
                        .frame(maxHeight: .infinity, alignment: .top)
                }
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
                .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(Theme.line))
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .shadow(color: .black.opacity(0.45), radius: 24, y: 8)
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
        .background(.white.opacity(0.05), in: Capsule())
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

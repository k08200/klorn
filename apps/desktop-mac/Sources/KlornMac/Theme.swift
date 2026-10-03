import AppKit
import SwiftUI

enum Theme {
    /// Raw sRGB components (0–1). Tokens that the self-check audits keep
    /// their values in this pure form so contrast math never needs AppKit.
    typealias RGBA = (r: Double, g: Double, b: Double, a: Double)

    /// Appearance-following color: AppKit resolves the closure against the
    /// EFFECTIVE appearance at draw time, so every consumer of these tokens
    /// flips with the app appearance (system / Preferences override) with no
    /// per-view work. Light values are byte-identical to the pre-dark theme.
    private static func dyn(light: RGBA, dark: RGBA) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let c = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: c.a)
        })
    }

    /// Canvas. NEUTRAL, deliberately unhooked from the web's navy (#0b1120):
    /// the founder-picked reference (Inbox Zero, 2026-08-25) keeps every
    /// surface hue-free so the only color on screen is color that MEANS
    /// something — lane tints, the accent, unread. A navy canvas put a blue
    /// cast under all of it and made the lane hues compete with the ground.
    static let bg = dyn(light: bgLight, dark: bgDark)
    /// The canvas as raw sRGB components — pure, so the self-check can do
    /// contrast math without resolving an NSColor (see `laneComponents`).
    static let bgLight: RGBA = (0.980, 0.980, 0.980, 1)
    static let bgDark: RGBA = (0.039, 0.039, 0.045, 1)
    /// The one interaction accent — CTAs, focus, selection, gauge. Everything
    /// "choose me / chosen" speaks in this; the brand marks themselves are B&W.
    /// Web v2 sky-500 `#0ea5e9`.
    static let accent = Color(red: 0.055, green: 0.647, blue: 0.914)
    /// Deep end of the accent gradient (gauge fill etc.) — sky-600 `#0284c7`
    /// in light; brightens to sky-400 in the dark like the web's accent-deep.
    static let accentDeep = dyn(light: (0.008, 0.518, 0.780, 1), dark: (0.220, 0.741, 0.973, 1))
    /// slate-200-grade hairline on the glass panel; faint white line in dark.
    static let line = dyn(light: (0, 0, 0, 0.08), dark: (1, 1, 1, 0.10))
    /// Panel bevel (GlassPanel edge): a top highlight that FADES DOWN the rim
    /// instead of outlining it — the Raycast/Sonoma panel edge. A flat stroke
    /// on a dark desktop reads as a drawn box; a fading bevel reads as light
    /// catching the material (founder feedback 2026-08-22: the border made
    /// the design worse).
    /// Light mode: white-on-near-white is invisible (~1.02:1, render-verified)
    /// — the light rim is a faint NEUTRAL hairline instead, still fading down
    /// so it never reads as a drawn box. Dark keeps the white bevel.
    static let bevelTop = dyn(light: (0, 0, 0, 0.07), dark: (1, 1, 1, 0.16))
    static let bevelBottom = dyn(light: (0, 0, 0, 0.03), dark: (1, 1, 1, 0.02))
    /// Interior top-edge light. Was a hardcoded white 0.9 — glaring in dark.
    static let edgeLight = dyn(light: (1, 1, 1, 0.90), dark: (1, 1, 1, 0.14))

    /// The floating surface. Dark is a neutral raised gray one step above the
    /// canvas — not navy (see `bg`).
    static let panel = dyn(
        light: (1, 1, 1, panelDefaultOpacity), dark: (0.078, 0.078, 0.086, panelDefaultOpacity))
    static let panelDefaultOpacity = 0.92

    /// Panel fill opacity: fully opaque when the user asked to reduce transparency
    /// (the 8% see-through can drop contrast over a busy backdrop), else the
    /// translucent default. Pure for testing.
    static func panelOpacity(reduceTransparency: Bool) -> Double {
        reduceTransparency ? 1.0 : panelDefaultOpacity
    }
    /// Near-black / near-white, hue-free (the slate ramp carried the navy cast
    /// into every glyph).
    static let text = dyn(light: (0.060, 0.060, 0.070, 1), dark: (0.957, 0.957, 0.965, 1))
    /// Secondary text, neutral gray. Contrast re-measured after the
    /// neutralization: light #52525C on the raised-over-white stack ≈ 6.9:1,
    /// dark #A2A2AD on the raised-over-panel stack ≈ 6.8:1 — both clear the
    /// WCAG AA 4.5:1 text floor with margin (caption sizes never qualify as
    /// "large text"). Never thin this with `.opacity()` on the color — the
    /// self-check bans the pattern.
    static let textDim = dyn(light: (0.320, 0.320, 0.360, 1), dark: (0.635, 0.635, 0.680, 1))

    /// Input-field boundary. `line` (black@0.08 ≈ 1.2:1) is fine for decorative
    /// dividers but fails WCAG 1.4.11 (≥3:1) for a control boundary; 0.35 ≈ 3:1
    /// on the white panel. Use only where a control edge must be perceivable.
    static let field = dyn(light: (0, 0, 0, 0.35), dark: (1, 1, 1, 0.45))

    /// The web engagement graph's "you engage with this sender" pink — reused by
    /// the reading pane's learned-engagement chip so desktop matches the web signal.
    /// Muted from the web graph's hot pink: at full saturation it outshouts the
    /// PUSH dot, and a learned-affinity hint must never look more urgent than
    /// urgency itself. ~4.3:1 on the panel — below the 4.5:1 text floor, fine
    /// for its actual use (chip icon + meter = non-text, 1.4.11 needs ≥3:1).
    /// Don't set text in this color.
    static let engage = Color(red: 0.776, green: 0.302, blue: 0.549)

    /// Per-lane palette — ONE palette on web and mac (FD-4,
    /// docs/design/productization-plan.md §2). Values are the web's
    /// `--tier-*-ink` tokens (packages/web/src/app/globals.css): Tailwind
    /// 700-level inks in light, the 400-level hues (`--color-tier-*`) in dark.
    /// This replaces the old mac ramp, where INFO and SILENT were two near-
    /// identical slates and MEETING was a teal the web never used.
    ///
    /// Light deliberately uses the ink, not the 400 hue, for dots AND text:
    /// the 400 hues are 1.5–2.7:1 on the light canvas, below even the 3:1
    /// non-text floor (WCAG 1.4.11), and `tint` already colors text (LaneChip,
    /// inline error lines). One theme-aware token keeps every call site AA.
    ///
    /// Measured text contrast (WCAG 2.2, 4.5:1 floor) — light on bg #FAFAFA /
    /// raised card; dark on bg / panel / raised card:
    ///   PUSH     #be123c 6.02 / 5.51   |  #fb7185 7.35 / 6.89 / 6.55
    ///   MEETING  #4f46e5 6.02 / 5.51   |  #818cf8 6.63 / 6.22 / 5.91
    ///   QUEUE    #b45309 4.81 / 4.40   |  #fbbf24 11.86 / 11.11 / 10.56
    ///   INFO     #0e7490 5.13 / 4.70   |  #22d3ee 10.95 / 10.26 / 9.75
    ///   SILENT   #57534e 7.30 / 6.69   |  #a8a29e 7.85 / 7.35 / 6.99
    /// Known gap: LaneChip sets 10pt text on a 13% wash of the same tint;
    /// light QUEUE measures 4.19:1 and INFO 4.46:1 there (dark: all ≥ 5.2).
    /// Both were far lower on the old ramp; the chip is rebuilt as a
    /// primitive in M7/P2, which owns the wash. The self-check pins the inks
    /// on `bg` in both appearances and the pairwise distinctness.
    static func tint(_ tier: Tier) -> Color {
        dyn(light: laneComponents(tier, dark: false), dark: laneComponents(tier, dark: true))
    }

    /// The lane color as pure sRGB components (no AppKit) — the source of
    /// truth `tint` resolves from, and what the self-check audits.
    static func laneComponents(_ tier: Tier, dark: Bool) -> RGBA {
        switch (tier, dark) {
        case (.push, false): hex(0xBE123C)  // rose-700
        case (.push, true): hex(0xFB7185)  // rose-400
        case (.meeting, false): hex(0x4F46E5)  // indigo-600
        case (.meeting, true): hex(0x818CF8)  // indigo-400
        case (.queue, false): hex(0xB45309)  // amber-700
        case (.queue, true): hex(0xFBBF24)  // amber-400
        case (.info, false): hex(0x0E7490)  // cyan-700
        case (.info, true): hex(0x22D3EE)  // cyan-400
        case (.silent, false): hex(0x57534E)  // stone-600
        case (.silent, true): hex(0xA8A29E)  // stone-400
        }
    }

    private static func hex(_ value: UInt32) -> RGBA {
        (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255,
         Double(value & 0xFF) / 255, 1)
    }

    // MARK: Label palette (2026-08-27)
    // NOTE (productization plan §2, 2026-10-02): category labels become
    // NEUTRAL in the reader — this hued palette is demoted in P5 (web Mail v2)
    // / M7 (mac tokens). Left as is until then; do not add new hues here.
    // The category labels were monochrome chips and the founder couldn't see
    // them ("라벨도 색깔도 없고… 눈에 안뜨임"). Labels are data — they get
    // hues, one per meaning, distinct from every lane hue so the two chip
    // families never read as one system. Light/dark pairs are tuned so the
    // chip TEXT (tint on a 13% tint wash over the panel) clears the 4.5:1
    // small-text floor in both modes — engage stays banned for text
    // (Theme.engage doc), which is why replied gets its own pink ramp.
    static func labelTint(_ filter: LabelFilter) -> Color {
        switch filter {
        // "No category label" is the honest meaning — it stays neutral.
        case .personal: textDim
        // The judge's verdicts. Indigo/rose/gold/slate — each far enough
        // from the Gmail-tab hues below that the two families stay distinct.
        case .company: dyn(light: (0.28, 0.32, 0.80, 1), dark: (0.64, 0.68, 1.0, 1))
        case .customer: dyn(light: (0.68, 0.14, 0.34, 1), dark: (1.0, 0.58, 0.68, 1))
        case .investor: dyn(light: (0.56, 0.42, 0.0, 1), dark: (0.90, 0.74, 0.30, 1))
        case .system: dyn(light: (0.32, 0.38, 0.52, 1), dark: (0.66, 0.72, 0.84, 1))
        // Money-adjacent — a warm bronze apart from investor's gold.
        case .billing: dyn(light: (0.52, 0.30, 0.08, 1), dark: (0.88, 0.62, 0.38, 1))
        case .promotions: dyn(light: (0.03, 0.42, 0.20, 1), dark: (0.38, 0.80, 0.50, 1))
        case .social: dyn(light: (0.12, 0.34, 0.78, 1), dark: (0.52, 0.70, 1.0, 1))
        case .updates: dyn(light: (0.55, 0.38, 0.0, 1), dark: (0.95, 0.76, 0.28, 1))
        case .forums: dyn(light: (0.42, 0.26, 0.74, 1), dark: (0.74, 0.64, 1.0, 1))
        case .firstContact: dyn(light: (0.0, 0.40, 0.54, 1), dark: (0.32, 0.76, 0.90, 1))
        // The reply axis — a mint apart from every category hue, so "you
        // owe an answer" never reads as a kind of sender.
        case .needsReply: dyn(light: (0.0, 0.46, 0.36, 1), dark: (0.40, 0.86, 0.70, 1))
        }
    }

    /// The chip color for a row's signal — same ramps as the sidebar rows via
    /// labelTint, so a chip and its category row always match. Replied is the
    /// relationship signal: a pink RAMP of its own (engage itself measures
    /// ~4.3:1 and is documented never-for-text).
    static func signalTint(_ signal: RowSignal) -> Color {
        switch signal {
        case .category(let name):
            // One lookup for both families — LabelFilter's raw values ARE the
            // wire's category strings, so a new category needs one enum case
            // and its tint, nowhere else.
            LabelFilter(rawValue: name).map { labelTint($0) } ?? textDim
        case .replied:
            dyn(light: (0.60, 0.14, 0.40, 1), dark: (0.96, 0.56, 0.76, 1))
        case .first:
            labelTint(.firstContact)
        }
    }

    /// Neutral panel shadow — one shadow color for every floating surface.
    /// (Was the web's navy-tinted shadow; a colored shadow is a hue cast.)
    static let panelShadow = dyn(light: (0, 0, 0, 0.18), dark: (0, 0, 0, 0.55))

    /// Glass tint, layered OVER the real blur material. Neutral top→bottom —
    /// barely darker at the foot so the surface still reads as lit material,
    /// with no color cast in either mode. Opacity applied by the caller
    /// (reduce-transparency mode raises it to near-solid, where the blur
    /// behind barely shows).
    static func panelGradient(opacity: Double) -> LinearGradient {
        LinearGradient(
            colors: [
                dyn(light: (1, 1, 1, opacity * 0.99), dark: (0.078, 0.078, 0.086, opacity * 0.99)),
                dyn(light: (0.975, 0.975, 0.978, opacity), dark: (0.055, 0.055, 0.063, opacity)),
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
    static let surfaceRaised = dyn(light: (0, 0, 0, 0.04), dark: (1, 1, 1, 0.06))  // cards, chips at rest
    static let surfaceHover = dyn(light: (0, 0, 0, 0.07), dark: (1, 1, 1, 0.10))  // pointer feedback
    /// Selection speaks in the accent — tinted fill (the accent bar still
    /// carries the hard edge, so selection is never color-alone).
    static let surfaceSelected = accent.opacity(0.12)

    /// Status signals (diagnostics dots). AppKit's system colors, so they
    /// follow light/dark and Increase Contrast. Never color-alone: callers
    /// pair them with a word.
    static let success = Color(nsColor: .systemGreen)
    static let warning = Color(nsColor: .systemOrange)
    static let danger = Color(nsColor: .systemRed)

    /// True only while `--render-previews` is drawing. See GlassPanel.
    nonisolated(unsafe) static var isRenderingOffscreen = false

    // MARK: Typography — the six-step scale (productization plan §2,
    // 2026-10-02; was the five-step scale of design renewal P0, 2026-08-21).
    // SF stays (native-feel doctrine, writing-style.md); unification with the
    // web happens at the HIERARCHY level, not the typeface: the step NAMES
    // match the web roles 1:1 (display/title/head/body/label/caption), the
    // mac sizes sit a notch under the web px. Every step is a deliberate
    // contrast jump so a glance separates statement (head) from metadata
    // (label/caption).
    enum Typo {
        /// Screen titles (Preferences, Teams, reading-pane subject). 22pt.
        static let display = Font.system(size: 22, weight: .semibold)
        /// Section/pane titles one step under display. 17pt.
        static let title = Font.system(size: 17, weight: .semibold)
        /// The statement a list is scanned for: subjects, section heads. 15pt.
        static let head = Font.system(size: 15, weight: .semibold)
        /// Running text. 13pt.
        static let body = Font.system(size: 13)
        /// Identity + controls: senders, buttons, chips. 12pt.
        static let label = Font.system(size: 12, weight: .medium)
        /// Metadata: reasons, timestamps, helper lines. 11pt.
        static let caption = Font.system(size: 11)
        /// DEPRECATED — the plan retires 10pt text; new code uses `caption`
        /// (11pt). Kept so existing call sites (column headers, LaneChip)
        /// keep compiling until the M7 view migration moves them.
        static let micro = Font.system(size: 10, weight: .semibold)
        /// Counts — monospaced digits so columns of numbers never shimmy.
        static let numeric = Font.system(size: 13).monospacedDigit()
        /// Row/nav icons — one size, one weight, everywhere.
        static let icon = Font.system(size: 12, weight: .medium)
    }

    // MARK: Radius (productization plan §2)
    // 6 controls, 10 rows/cards/popovers, 16 sheets/windows. Pills and
    // LaneChip use the Capsule SHAPE, not a radius token. Call sites migrate
    // in M7 — new code picks a rung instead of a raw cornerRadius literal.
    enum Radius {
        /// Controls: buttons, fields, small toggles.
        static let sm: CGFloat = 6
        /// Rows, cards, popovers.
        static let md: CGFloat = 10
        /// Sheets and windows.
        static let lg: CGFloat = 16
    }

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
        // Inherit the app appearance — dark mode turns the glass dark.
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
                    // ImageRenderer cannot draw an NSViewRepresentable — it emits a
                    // placeholder that swamps the whole surface — so the offscreen
                    // design renderer substitutes a flat stand-in for the blur.
                    // Runtime behaviour is untouched.
                    if Theme.isRenderingOffscreen {
                        Rectangle().fill(Theme.bg)
                    } else {
                        GlassMaterial(cornerRadius: cornerRadius)
                    }
                    Theme.panelGradient(
                        opacity: Theme.glassTintOpacity(reduceTransparency: reduceTransparency))
                    LinearGradient(
                        colors: [Theme.edgeLight, .clear],
                        startPoint: .top, endPoint: .center)
                        .frame(height: 1.5, alignment: .top)
                        .frame(maxHeight: .infinity, alignment: .top)
                }
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
                // No outline. The rim is a bevel — light catching the top of
                // the material, gone by the bottom — and the shadow does the
                // figure-ground separation.
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .strokeBorder(
                            LinearGradient(
                                colors: [Theme.bevelTop, Theme.bevelBottom],
                                startPoint: .top, endPoint: .bottom)))
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .shadow(color: Theme.panelShadow, radius: 28, y: 10)
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
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .background(
                LinearGradient(
                    colors: [Theme.accent, Theme.accentDeep],
                    startPoint: .top, endPoint: .bottom),
                in: Capsule())
            .shadow(color: Theme.accent.opacity(isEnabled ? 0.35 : 0), radius: 6, y: 2)
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1.0) : 0.45)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

/// The standard quiet empty/guidance state: dim icon, one calm line, and an
/// optional hint. Every "nothing here" moment uses this instead of a bare
/// dim string, so emptiness reads as designed rather than unfinished.
/// First-sync truth (design renewal P1): while the queue has never loaded,
/// the list must say "reading your mailbox", not "empty" — an EmptyState
/// before the first load is a lie that makes a new tester think Klorn found
/// nothing. Placeholder bars pulse gently unless Reduce Motion is on.
struct FirstSyncState: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s4) {
            ForEach(0..<4, id: \.self) { row in
                HStack(spacing: Theme.s3) {
                    Circle().fill(Theme.surfaceHover).frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: Theme.s1) {
                        RoundedRectangle(cornerRadius: 3).fill(Theme.surfaceHover)
                            .frame(width: 90, height: 8)
                        RoundedRectangle(cornerRadius: 3).fill(Theme.surfaceHover)
                            .frame(width: row.isMultiple(of: 2) ? 260 : 200, height: 11)
                    }
                    Spacer()
                }
            }
            HStack(spacing: Theme.s2) {
                if !Theme.isRenderingOffscreen {
                    ProgressView().controlSize(.small)
                }
                Text(L("list.firstSync")).font(Theme.Typo.body).foregroundStyle(Theme.textDim)
            }
            Text(L("list.firstSync.detail"))
                .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 24).padding(.vertical, Theme.s4)
        .opacity(pulsing ? 0.55 : 1)
        .onAppear {
            guard !reduceMotion, !Theme.isRenderingOffscreen else { return }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                pulsing = true
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(L("list.firstSync"))
    }
}

struct EmptyState: View {
    let icon: String
    let title: String
    var hint: String? = nil

    var body: some View {
        VStack(spacing: Theme.s3) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(Theme.textDim)
                .opacity(0.7)
                .accessibilityHidden(true)
            Text(title).font(.callout).foregroundStyle(Theme.textDim)
            if let hint {
                Text(hint).font(.caption).foregroundStyle(Theme.textDim)
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
                Text(L("mail.reclassifying")).font(.caption2).foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 4)
        .listRowBackground(Color.clear)
    }
}

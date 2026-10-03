import SwiftUI

/// Klorn wordmark ring — the small circular logo from the reference bar.
struct LogoRing: View {
    var size: CGFloat = 16
    var body: some View {
        // The K mark — the app icon in miniature, so pill, panel, menu bar,
        // and Dock all say the same thing: Klorn. Ink on the light panel,
        // matching the B&W brand icon (founder direction 2026-07-20: no orange).
        Text("K")
            .font(.system(size: size * 0.82, weight: .heavy, design: .rounded))
            .foregroundStyle(Theme.text)
            .frame(width: size, height: size)
            .accessibilityHidden(true)  // decorative wordmark mark
    }
}

extension View {
    /// Enlarge an icon control's hit area to clear WCAG 2.5.8 Target Size (24pt AA;
    /// 28 gives margin) without changing the glyph size. Frame the label content.
    func iconTarget(_ side: CGFloat = 28) -> some View {
        frame(width: side, height: side).contentShape(Rectangle())
    }
}

/// Sidebar feature-row icon: a tinted rounded container in the System
/// Settings idiom. Two rules against the generic-AI look (founder
/// 2026-08-21, second pass): the GLYPH must carry product meaning — never
/// the first-search default (sparkles is banned; the assistant is a
/// conversation, a promise is a seal, a proposal awaits a signature) —
/// and the TINT comes from the palette's existing SEMANTIC tokens (engage =
/// relationships, accent = Klorn asking to act, meeting green = schedule),
/// so variety reads as meaning, not as a template rainbow.
/// Sidebar glyph container. Monochrome by default (pass 2026-08-25): nav
/// icons don't decorate. The exception is a glyph whose color IS data — the
/// 카테고리 rows pass their label tint (2026-08-27), matching the chip the
/// same label wears on every row. Decorative tints stay banned.
struct FeatureIcon: View {
    let systemName: String
    var tint: Color? = nil
    var body: some View {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(tint.map { AnyShapeStyle($0.opacity(0.13)) }
                ?? AnyShapeStyle(Theme.surfaceRaised))
            .frame(width: 20, height: 20)
            .overlay(
                Image(systemName: systemName)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(tint ?? Theme.textDim))
            .accessibilityHidden(true)
    }
}

struct ColumnHeader: View {
    let title: String

    /// Wide tracking is a Latin small-caps device: it makes "RECENT PUSH" read
    /// as a deliberate micro-label rather than a shrunken heading. Hangul
    /// syllable blocks already carry their own internal spacing, so the same
    /// value pulls "최근 PUSH" apart and costs legibility. Tracking is
    /// script-specific; one value was always going to be wrong for one script.
    nonisolated static func tracking(for title: String) -> CGFloat {
        title.contains(where: \.isHangul) ? 0 : 1.4
    }

    var body: some View {
        Text(title).font(Theme.Typo.micro)
            .foregroundStyle(Theme.textDim).tracking(Self.tracking(for: title))
    }
}

extension Character {
    /// Hangul syllables, plus the Jamo blocks a decomposed string can carry.
    var isHangul: Bool {
        unicodeScalars.contains { s in
            (0xAC00...0xD7A3).contains(s.value)  // syllables
                || (0x1100...0x11FF).contains(s.value)  // conjoining jamo
                || (0x3130...0x318F).contains(s.value)  // compatibility jamo
        }
    }
}

/// A quiet text action: dim at rest, full text color on hover. The standard
/// for secondary actions (headers, ACCOUNT rows) so emphasis stays reserved
/// for primary content and the accent.
struct SubtleTextButton: View {
    let title: String
    var dim = true
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title).font(.body)
                .foregroundStyle(hovering || !dim ? Theme.text : Theme.textDim)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// Sidebar nav row chrome: the same selection language as list rows — accent
/// leading bar + the surface ladder's selected rung; hover uses the hover rung.
/// One modifier so every nav row (tiers, Commitments, Assistant) stays in sync.
struct SidebarRowChrome: ViewModifier {
    let selected: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(alignment: .leading) {
                if selected {
                    RoundedRectangle(cornerRadius: 1.5).fill(Theme.accent)
                        .frame(width: 3).padding(.vertical, 5)
                }
            }
            .background(
                selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear,
                in: RoundedRectangle(cornerRadius: 8))
            .onHover { hovering = $0 }
    }
}

/// Stand-in for a `Menu` while the offscreen renderer runs. Menus are
/// AppKit-backed and ImageRenderer paints them as a "restricted" placeholder
/// glyph, which would otherwise end up in the screenshots the landing page
/// ships. Same size and chrome, no AppKit.
struct OffscreenMenuLabel: View {
    let title: String
    var body: some View {
        (Text(title) + Text(Image(systemName: "chevron.down")))
            .font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.line))
    }
}

/// Sun/moon appearance toggle (founder 2026-08-27: switchable from the top
/// right). Shows the mode a CLICK gives you — the universal toggle idiom —
/// and writes an explicit choice over "system" (the Preferences picker still
/// offers system-follow for those who want it back).
struct AppearanceToggle: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme

    private var isDark: Bool {
        switch model.settings.appearance {
        case .dark: true
        case .light: false
        case .system: colorScheme == .dark
        }
    }

    var body: some View {
        Button {
            model.settings.appearance = isDark ? .light : .dark
        } label: {
            Image(systemName: isDark ? "sun.max" : "moon")
                .font(.callout).iconTarget()
        }
        .buttonStyle(.plain).hoverDim()
        .help(isDark ? L("appearance.toLight") : L("appearance.toDark"))
        .accessibilityLabel(isDark ? L("appearance.toLight") : L("appearance.toDark"))
    }
}

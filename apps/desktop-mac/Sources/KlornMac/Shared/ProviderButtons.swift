import SwiftUI

// Sign-in provider buttons drawn to the providers' own rules (audit M5).
// Google: Sign in with Google branding guidelines — a white button (#FFFFFF,
// #747775 stroke, #1F1F1F text; dark theme #131314 / #8E918F / #E3E3E3) with
// the full-colour "G" at its official geometry. Apple: HIG Sign in with
// Apple — black with the Apple logo in light, white in dark, logo and title
// in one flat colour. The G paths are the ones the web already ships
// (packages/web/src/components/auth/provider-marks.tsx), converted to
// SwiftUI paths in the same 24-unit box (arcs as cubic Béziers).

/// The official multicolour Google "G".
struct GoogleGMark: View {
    var size: CGFloat = 18

    var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / 24
            let pt: (CGFloat, CGFloat) -> CGPoint = { CGPoint(x: $0 * scale, y: $1 * scale) }
            context.fill(Self.blue(pt), with: .color(Self.hexColor(0x4285F4)))
            context.fill(Self.green(pt), with: .color(Self.hexColor(0x34A853)))
            context.fill(Self.yellow(pt), with: .color(Self.hexColor(0xFBBC05)))
            context.fill(Self.red(pt), with: .color(Self.hexColor(0xEA4335)))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// The brand colours are fixed; they never follow the appearance.
    static func hexColor(_ value: UInt32) -> Color {
        let c = Theme.hex(value)
        return Color(.sRGB, red: c.r, green: c.g, blue: c.b, opacity: 1)
    }

    /// The four brand colours, in the order the mark is painted.
    static let brandColors: [UInt32] = [0x4285F4, 0x34A853, 0xFBBC05, 0xEA4335]

    private static func blue(_ pt: (CGFloat, CGFloat) -> CGPoint) -> Path {
        Path { p in
            p.move(to: pt(22.560, 12.250))
            p.addCurve(to: pt(22.360, 10.000), control1: pt(22.560, 11.470), control2: pt(22.490, 10.720))
            p.addLine(to: pt(12.000, 10.000))
            p.addLine(to: pt(12.000, 14.260))
            p.addLine(to: pt(17.920, 14.260))
            p.addCurve(to: pt(15.720, 17.580), control1: pt(17.671, 15.621), control2: pt(16.876, 16.821))
            p.addLine(to: pt(15.720, 20.350))
            p.addLine(to: pt(19.290, 20.350))
            p.addCurve(to: pt(22.570, 12.250), control1: pt(21.370, 18.430), control2: pt(22.570, 15.610))
            p.closeSubpath()
        }
    }
    private static func green(_ pt: (CGFloat, CGFloat) -> CGPoint) -> Path {
        Path { p in
            p.move(to: pt(12.000, 23.000))
            p.addCurve(to: pt(19.280, 20.340), control1: pt(14.970, 23.000), control2: pt(17.460, 22.020))
            p.addLine(to: pt(15.710, 17.570))
            p.addCurve(to: pt(12.000, 18.630), control1: pt(14.730, 18.230), control2: pt(13.480, 18.630))
            p.addCurve(to: pt(5.840, 14.100), control1: pt(9.140, 18.630), control2: pt(6.710, 16.700))
            p.addLine(to: pt(2.180, 14.100))
            p.addLine(to: pt(2.180, 16.940))
            p.addCurve(to: pt(12.000, 23.000), control1: pt(3.990, 20.530), control2: pt(7.700, 23.000))
            p.closeSubpath()
        }
    }
    private static func yellow(_ pt: (CGFloat, CGFloat) -> CGPoint) -> Path {
        Path { p in
            p.move(to: pt(5.840, 14.090))
            p.addCurve(to: pt(5.490, 12.000), control1: pt(5.620, 13.430), control2: pt(5.490, 12.730))
            p.addCurve(to: pt(5.840, 9.910), control1: pt(5.490, 11.270), control2: pt(5.620, 10.570))
            p.addLine(to: pt(5.840, 7.070))
            p.addLine(to: pt(2.180, 7.070))
            p.addCurve(to: pt(1.000, 12.000), control1: pt(1.430, 8.550), control2: pt(1.000, 10.220))
            p.addCurve(to: pt(2.180, 16.930), control1: pt(1.000, 13.780), control2: pt(1.430, 15.450))
            p.addLine(to: pt(5.030, 14.710))
            p.addLine(to: pt(5.840, 14.090))
            p.closeSubpath()
        }
    }
    private static func red(_ pt: (CGFloat, CGFloat) -> CGPoint) -> Path {
        Path { p in
            p.move(to: pt(12.000, 5.380))
            p.addCurve(to: pt(16.210, 7.020), control1: pt(13.620, 5.380), control2: pt(15.060, 5.940))
            p.addLine(to: pt(19.360, 3.870))
            p.addCurve(to: pt(12.000, 1.000), control1: pt(17.450, 2.090), control2: pt(14.970, 1.000))
            p.addCurve(to: pt(2.180, 7.070), control1: pt(7.700, 1.000), control2: pt(3.990, 3.470))
            p.addLine(to: pt(5.840, 9.910))
            p.addCurve(to: pt(12.000, 5.380), control1: pt(6.710, 7.310), control2: pt(9.140, 5.380))
            p.closeSubpath()
        }
    }
}

/// The provider button looks, as pure values the self-check pins.
enum ProviderButtonSpec {
    static let height: CGFloat = 36
    static let markSize: CGFloat = 18
    static let googleFillLight = Theme.hex(0xFFFFFF)
    static let googleStrokeLight = Theme.hex(0x747775)
    static let googleTextLight = Theme.hex(0x1F1F1F)
    static let googleFillDark = Theme.hex(0x131314)
    static let googleStrokeDark = Theme.hex(0x8E918F)
    static let googleTextDark = Theme.hex(0xE3E3E3)
    /// Apple: black in light, white in dark (HIG).
    static let appleFillLight = Theme.hex(0x000000)
    static let appleFillDark = Theme.hex(0xFFFFFF)
    static let appleSymbol = "apple.logo"
}

/// "Continue with Google": the G at the leading edge, the label centred.
struct GoogleProviderButtonStyle: ButtonStyle {
    var fullWidth = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 10) {
            GoogleGMark(size: ProviderButtonSpec.markSize)
            configuration.label
                .font(Theme.Typo.body.weight(.medium))
                .foregroundStyle(Theme.dyn(
                    light: ProviderButtonSpec.googleTextLight, dark: ProviderButtonSpec.googleTextDark))
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: ProviderButtonSpec.height)
        .background(
            Theme.dyn(light: ProviderButtonSpec.googleFillLight, dark: ProviderButtonSpec.googleFillDark),
            in: RoundedRectangle(cornerRadius: Theme.Radius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.dyn(
                light: ProviderButtonSpec.googleStrokeLight, dark: ProviderButtonSpec.googleStrokeDark)))
        .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.5)
    }
}

/// "Sign in with Apple": SF Symbol apple.logo and the title in one colour.
struct AppleProviderButtonStyle: ButtonStyle {
    var fullWidth = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let ink = Theme.dyn(light: ProviderButtonSpec.appleFillDark, dark: ProviderButtonSpec.appleFillLight)
        HStack(spacing: 8) {
            Image(systemName: ProviderButtonSpec.appleSymbol)
                .font(.system(size: 15, weight: .medium))
                .accessibilityHidden(true)
            configuration.label.font(Theme.Typo.body.weight(.medium))
        }
        .foregroundStyle(ink)
        .padding(.horizontal, 12)
        .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: ProviderButtonSpec.height)
        .background(
            Theme.dyn(light: ProviderButtonSpec.appleFillLight, dark: ProviderButtonSpec.appleFillDark),
            in: RoundedRectangle(cornerRadius: Theme.Radius.sm))
        .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.5)
    }
}

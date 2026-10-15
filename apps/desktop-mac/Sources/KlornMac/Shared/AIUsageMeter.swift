import SwiftUI

/// Today's AI usage against the daily cap. Lived in the expanded panel's
/// account column until the panel was removed (founder decision 2026-10-15);
/// Settings ▸ Accounts shows it now, beside the account it is billed to.
struct AIUsageMeter: View {
    let used: Int
    let cap: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(L("section.aiToday")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.surfaceHover)
                    Capsule()
                        .fill(LinearGradient(
                            colors: [Theme.accent, Theme.accentDeep],
                            startPoint: .leading, endPoint: .trailing))
                        .frame(width: geo.size.width * usageFillFraction(used: used, cap: cap))
                }
            }
            .frame(height: 5)
            Text(usageLabel(used: used, cap: cap))
                .font(.caption2.monospacedDigit()).foregroundStyle(Theme.textDim)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(L("aiUsage.a11y", used, cap))
    }
}

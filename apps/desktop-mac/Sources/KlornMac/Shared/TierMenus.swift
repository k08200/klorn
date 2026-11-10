import SwiftUI

/// A snooze control that pops the option list. Shared by every snooze site so the
/// choices stay identical; the caller supplies the label (icon vs. text button).
struct SnoozeMenu<Label: View>: View {
    let item: FirewallItem
    let onSnooze: (FirewallItem, SnoozeOption) -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Menu {
            ForEach(SnoozeOption.allCases) { option in
                Button(option.label) { onSnooze(item, option) }
            }
        } label: { label() }
    }
}

/// Tier-correction control: pick the tier this item SHOULD be. Shared by the
/// list row (dot) and the reading pane (text button). The current tier shows a
/// checkmark; picking another calls onSetTier — the correction persists via the
/// override endpoint and (≥2 identical for a sender) trains future triage.
struct TierMenu<Label: View>: View {
    let item: FirewallItem
    let onSetTier: (FirewallItem, Tier) -> Void
    let onPinSender: (FirewallItem, Tier) -> Void
    let onUnpinSender: (FirewallItem) -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Menu {
            ForEach(Tier.displayOrder) { tier in
                Button {
                    onSetTier(item, tier)
                } label: {
                    HStack {
                        Text(tier.label)
                        if tier == item.tier { Image(systemName: "checkmark") }
                    }
                }
                .disabled(tier == item.tier)
            }
            // Pins only make sense for mail (the judge keys them by sender).
            if item.email != nil {
                Divider()
                Menu(L("pin.always")) {
                    ForEach(Tier.displayOrder) { tier in
                        Button(tier.label) { onPinSender(item, tier) }
                    }
                }
                Button(L("pin.remove")) { onUnpinSender(item) }
            }
        } label: { label() }
    }
}

import SwiftUI

/// Actions the main window's shell delegates back to the window router
/// (`WindowRouter.makeActions()`) and the model. Was the top bar's action set while the
/// pill and the expanded panel shared it; the pill-only entries went with
/// them (founder decision 2026-10-15).
struct ShellActions {
    let onSignIn: () -> Void
    let onSignOut: () -> Void
    /// Open an item IN-APP: open the main window and show it in the reading pane.
    let onOpenInApp: (FirewallItem) -> Void
    /// Open a whole tier IN-APP: open the main window with that tier listed.
    let onOpenTier: (Tier) -> Void
    /// Open the main window without changing what it is showing.
    let onOpenFull: () -> Void
    /// Open the main window on the proposals list — the actions awaiting approval.
    let onOpenProposals: () -> Void
    /// Dismiss (archive) an item out of the queue.
    let onDismiss: (FirewallItem) -> Void
    /// Snooze an item to resurface at the chosen time.
    let onSnooze: (FirewallItem, SnoozeOption) -> Void
    /// Tier correction — move an item to a different tier (teaches the judge).
    let onSetTier: (FirewallItem, Tier) -> Void
    /// Sender pin — "this sender is ALWAYS this lane" (a rule the judge obeys
    /// before any prediction, unlike corrections which only train a prior).
    let onPinSender: (FirewallItem, Tier) -> Void
    /// Remove the sender's pin; triage goes back to learned/predicted tiers.
    let onUnpinSender: (FirewallItem) -> Void
    /// Select a row in the mail list — loads its email into the reading pane.
    let onSelect: (FirewallItem) -> Void
    /// Open the Settings window.
    let onOpenPreferences: () -> Void
    let onQuit: () -> Void
}

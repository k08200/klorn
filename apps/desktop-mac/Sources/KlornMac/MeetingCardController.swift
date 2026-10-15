import AppKit
import SwiftUI

/// Owns the meeting-prep card: a top-center floating card that never takes
/// the keyboard (the card is mouse-only). One meeting at a time; each event id surfaces at most once
/// per app run (`shownMeetingIds` lives in AppModel so replans stay pure).
@MainActor
final class MeetingCardController {
    private let model: AppModel
    /// Internal (not private) so the self-check can read what the card shows.
    let state = MeetingCardState()
    /// Self-check mode: no panel, no sound.
    private let headless: Bool
    private var panel: NSPanel?
    /// Defers when something else holds the slot; the planner re-offers the
    /// meeting on the next refresh tick. Nothing shares it since the
    /// urgent-mail card was removed (2026-10-15), so the app passes `false`.
    private let isSlotBusy: () -> Bool

    /// The arrival chime follows the local banner switch. Pure for testing.
    nonisolated static func shouldChime(alertsEnabled: Bool) -> Bool { alertsEnabled }

    var isVisible: Bool { panel?.isVisible ?? false }

    init(model: AppModel, headless: Bool = false, isSlotBusy: @escaping () -> Bool) {
        self.model = model
        self.headless = headless
        self.isSlotBusy = isSlotBusy
    }

    /// The session ended: the meeting on the card is the previous account's.
    /// Wired to `AppModel.onSessionEnded`.
    func reset() {
        state.event = nil
        state.pack = nil
        panel?.orderOut(nil)
    }

    /// Present the prep card for an upcoming meeting. Returns false when the
    /// slot is occupied (caller keeps the event un-shown so it re-offers).
    @discardableResult
    func present(_ event: CalendarEventWire) -> Bool {
        guard headless || NSScreen.main != nil, !isSlotBusy(), !isVisible else { return false }
        state.event = event
        state.pack = nil
        render()
        if !headless, Self.shouldChime(alertsEnabled: model.settings.notificationsEnabled) {
            NSSound(named: "Glass")?.play()
        }
        let stamp = model.sessionGeneration
        Task { [weak self] in
            guard let self else { return }
            let pack = await self.model.fetchPrepPack(eventId: event.id, session: stamp)
            guard self.model.isCurrent(stamp), self.state.event?.id == event.id else { return }
            self.state.pack = pack
        }
        return true
    }

    private func dismiss() {
        state.event = nil
        panel?.orderOut(nil)
    }

    private func join() {
        if let url = MeetingLink.safeURL(state.event?.meetingLink) {
            NSWorkspace.shared.open(url)
        }
        dismiss()
    }

    private func render() {
        guard !headless else { return }
        let wasVisible = panel?.isVisible ?? false
        let panel = self.panel ?? makePanel()
        self.panel = panel
        if panel.contentView == nil || !(panel.contentView is NSHostingView<MeetingCard>) {
            panel.contentView = NSHostingView(rootView: MeetingCard(
                state: state,
                actions: MeetingCardActions(
                    onJoin: { [weak self] in self?.join() },
                    onDismiss: { [weak self] in self?.dismiss() })))
        }
        guard let visible = NSScreen.main?.visibleFrame else { return }
        let target = MeetingCardMetrics.cardFrame(size: MeetingCardMetrics.compact, visible: visible)
        let animate = WindowGeometry.shouldAnimateFrame(
            reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        if !wasVisible && animate {
            panel.setFrame(MeetingCardMetrics.presentStartFrame(target: target), display: false)
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.22
                panel.animator().alphaValue = 1
            }
            panel.setFrame(target, display: true, animate: true)
        } else {
            panel.alphaValue = 1
            panel.setFrame(target, display: true, animate: false)
            panel.orderFrontRegardless()
        }
        panel.applyGlassShape(cornerRadius: MeetingCardMetrics.corner)
        let settle = panel.animationResizeTime(target) + 0.05
        DispatchQueue.main.asyncAfter(deadline: .now() + settle) { [weak panel] in
            panel?.invalidateShadow()
        }
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: MeetingCardMetrics.compact),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // Light v2: the panel is always a light surface — pin the effective
        // appearance so semantic colors resolve light even in system dark mode.
        // Appearance follows NSApp (system or the Preferences override) —
        // the light pin predates dark mode (2026-08-15).
        panel.appearance = nil
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        return panel
    }
}

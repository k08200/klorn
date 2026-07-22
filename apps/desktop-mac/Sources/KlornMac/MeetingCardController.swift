import AppKit
import SwiftUI

/// Owns the meeting-prep card: same top-center slot, morph, and focus
/// contract as the PushCard (never takes the keyboard — the card is
/// mouse-only). One meeting at a time; each event id surfaces at most once
/// per app run (`shownMeetingIds` lives in AppModel so replans stay pure).
@MainActor
final class MeetingCardController {
    private let model: AppModel
    private let state = MeetingCardState()
    private var panel: NSPanel?
    /// Defers to the PushCard when both want the slot (mail interrupt wins);
    /// the planner will re-offer the meeting on the next refresh tick.
    private let isSlotBusy: () -> Bool

    var isVisible: Bool { panel?.isVisible ?? false }

    init(model: AppModel, isSlotBusy: @escaping () -> Bool) {
        self.model = model
        self.isSlotBusy = isSlotBusy
    }

    /// Present the prep card for an upcoming meeting. Returns false when the
    /// slot is occupied (caller keeps the event un-shown so it re-offers).
    @discardableResult
    func present(_ event: CalendarEventWire) -> Bool {
        guard NSScreen.main != nil, !isSlotBusy(), !isVisible else { return false }
        state.event = event
        state.pack = nil
        render()
        if PushCardController.shouldChime(newCount: 1, alertsEnabled: model.settings.notificationsEnabled) {
            NSSound(named: "Glass")?.play()
        }
        Task { [weak self] in
            guard let self else { return }
            let pack = await self.model.fetchPrepPack(eventId: event.id)
            guard self.state.event?.id == event.id else { return }
            self.state.pack = pack
        }
        return true
    }

    private func dismiss() {
        state.event = nil
        panel?.orderOut(nil)
    }

    private func join() {
        if let link = state.event?.meetingLink, let url = URL(string: link) {
            NSWorkspace.shared.open(url)
        }
        dismiss()
    }

    private func render() {
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
        let target = PushCardController.cardFrame(size: PushCardMetrics.compact, visible: visible)
        let animate = TopBarController.shouldAnimateFrame(
            reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        if !wasVisible && animate {
            panel.setFrame(PushCardMetrics.presentStartFrame(target: target), display: false)
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
        panel.applyGlassShape(cornerRadius: PushCardMetrics.corner)
        let settle = panel.animationResizeTime(target) + 0.05
        DispatchQueue.main.asyncAfter(deadline: .now() + settle) { [weak panel] in
            panel?.invalidateShadow()
        }
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: PushCardMetrics.compact),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // Light v2: the panel is always a light surface — pin the effective
        // appearance so semantic colors resolve light even in system dark mode.
        panel.appearance = NSAppearance(named: .aqua)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        return panel
    }
}

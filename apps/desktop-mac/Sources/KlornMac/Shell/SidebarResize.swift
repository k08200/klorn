import SwiftUI

/// Draggable boundary above the ACCOUNT section: dragging up grows the
/// account area, the TODAY/UPCOMING scroll region flexes to absorb it.
/// Height persists via AppSettings. VoiceOver adjusts in 20pt steps.
/// ScrollView at runtime; a plain container under the offscreen design
/// renderer, which cannot draw ScrollView content (PreviewRender note).
struct OffscreenFriendlyScroll<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        if Theme.isRenderingOffscreen {
            content()
        } else {
            ScrollView(showsIndicators: true) { content() }
        }
    }
}

/// Reports a view's laid-out height so a capped section's drag can clamp to
/// real content (a cap beyond content is a dead zone the cursor rubber-bands
/// through).
private struct SectionHeightKey: PreferenceKey {
    nonisolated(unsafe) static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

extension View {
    func measureSectionHeight(_ into: @escaping (CGFloat) -> Void) -> some View {
        background(
            GeometryReader { geo in
                Color.clear.preference(key: SectionHeightKey.self, value: geo.size.height)
            }
        )
        .onPreferenceChange(SectionHeightKey.self) { into($0) }
    }
}

struct SectionResizeHandle: View {
    @Binding var height: Double
    /// True when the resizable section sits ABOVE this handle (dragging the
    /// boundary DOWN should grow it). False = section below (account), where
    /// dragging UP grows. The account handle shipped first and set the
    /// up=grow default; the today handle reused it unflipped, which is why
    /// it felt dead in the wrong direction (dogfood 2026-08-19).
    var growsDown = false

    @State private var hovering = false

    var body: some View {
        ZStack {
            // AppKit-level drag surface: the panel is movable-by-background,
            // and AppKit claims a drag on any non-refusing view as a WINDOW
            // MOVE before SwiftUI's DragGesture ever fires (v0.4.80040 bug —
            // the handle "did nothing"). An NSView that answers
            // mouseDownCanMoveWindow=false is the only reliable refusal.
            ResizeDragSurface(
                startHeight: { height }, apply: { height = $0 }, growsDown: growsDown)
            // macOS-divider look: a hairline across the column with a centred
            // grabber that answers hover — visibly a control, not lint.
            // Quiet at rest (founder 2026-08-21: four identical grabbers
            // stacked read as clutter): the boundary is just a hairline until
            // hovered — then the hairline yields to the accent grabber. One
            // boundary, one line, and the affordance appears where the
            // pointer already is.
            VStack(spacing: 0) {
                Rectangle().fill(Theme.line.opacity(hovering ? 0 : 1))
                    .frame(height: 1)
            }
            .allowsHitTesting(false)
            Capsule()
                .fill(Theme.accent.opacity(0.85))
                .frame(width: 44, height: 5)
                .opacity(hovering ? 1 : 0)
                .animation(.easeOut(duration: 0.12), value: hovering)
                .allowsHitTesting(false)
        }
        .frame(height: 14)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement()
        .accessibilityLabel(L("sidebar.resize.a11y"))
        .accessibilityValue(Text("\(Int(height))"))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: height += 20
            case .decrement: height -= 20
            @unknown default: break
            }
        }
    }
}

private struct ResizeDragSurface: NSViewRepresentable {
    let startHeight: () -> Double
    let apply: (Double) -> Void
    var growsDown = false

    func makeNSView(context _: Context) -> ResizeDragNSView {
        let view = ResizeDragNSView()
        view.startHeight = startHeight
        view.apply = apply
        view.growsDown = growsDown
        return view
    }

    func updateNSView(_ view: ResizeDragNSView, context _: Context) {
        view.startHeight = startHeight
        view.apply = apply
        view.growsDown = growsDown
    }
}

final class ResizeDragNSView: NSView {
    var startHeight: () -> Double = { 0 }
    var apply: (Double) -> Void = { _ in }
    var growsDown = false
    private var dragStartHeight: Double = 0
    private var dragStartScreenY: CGFloat = 0

    // The whole point: refuse the window-move claim so the drag is OURS.
    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with _: NSEvent) {
        dragStartHeight = startHeight()
        dragStartScreenY = NSEvent.mouseLocation.y
    }

    override func mouseDragged(with _: NSEvent) {
        // Screen Y grows upward on macOS. For a section BELOW the handle
        // (account), dragging up (positive dy) grows it; for a section ABOVE
        // (수신함/오늘/예정), dragging down grows it — hence the sign flip.
        let dy = NSEvent.mouseLocation.y - dragStartScreenY
        apply(dragStartHeight + (growsDown ? -Double(dy) : Double(dy)))
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .resizeUpDown)
    }
}

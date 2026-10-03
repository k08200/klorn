import SwiftUI

/// One segment of a `SegmentedBar`.
struct BarSegment<Value: Hashable>: Identifiable {
    let value: Value
    let title: String
    /// Shown after the title when set (pending approvals, open commitments).
    var count: Int? = nil
    /// A leading dot whose color is data (a lane tint). Never decoration.
    var dot: Color? = nil

    var id: Value { value }
}

/// Filter tabs for the main window (M4b): lanes in Mail, panes in Assistant,
/// calendar vs team in Calendar. Plain SwiftUI buttons rather than a
/// segmented `Picker`, so the same view draws on screen and in the
/// offscreen renderer (which paints AppKit controls as placeholders), and
/// "nothing selected" is a real state (a folder is open, no lane is lit).
struct SegmentedBar<Value: Hashable>: View {
    let segments: [BarSegment<Value>]
    let selection: Value?
    let label: String
    let onSelect: (Value) -> Void

    var body: some View {
        HStack(spacing: Theme.s1) {
            ForEach(segments) { segment in
                SegmentButton(
                    segment: segment, selected: segment.value == selection,
                    action: { onSelect(segment.value) })
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}

private struct SegmentButton<Value: Hashable>: View {
    let segment: BarSegment<Value>
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let dot = segment.dot {
                    Circle().fill(dot).frame(width: 6, height: 6).accessibilityHidden(true)
                }
                Text(segment.title)
                    .font(Theme.Typo.label)
                    .foregroundStyle(selected ? Theme.text : Theme.textDim)
                if let count = segment.count, count > 0 {
                    Text("\(count)")
                        .font(Theme.Typo.caption.monospacedDigit())
                        .foregroundStyle(Theme.textDim)
                }
            }
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 10)
            .frame(height: 28)
            .background(
                selected ? Theme.surfaceHover : hovering ? Theme.surfaceRaised : .clear,
                in: RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Neutral monochrome source glyph for an account (productization plan §2).
struct SourceBadge: View {
    let provider: String?

    var body: some View {
        let glyph = sourceMonogram(provider: provider)
        Text(glyph)
            .font(.system(size: glyph.count > 2 ? 8 : 10, weight: .bold, design: .rounded))
            .foregroundStyle(Theme.textDim)
            .frame(width: 20, height: 20)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.line))
            .accessibilityHidden(true)
    }
}

import SwiftUI

/// BRIEFING preview card — the day's AI briefing. One view shared by the
/// compact panel's TodayColumn and the full-mode sidebar so both surfaces
/// render the same card (dogfood 2026-07-23). Clicking opens the full view,
/// which is where the day is actually worked.
struct BriefingCard: View {
    let briefing: String?
    let structure: BriefingStructure?
    let onOpen: () -> Void

    var body: some View {
        Button { onOpen() } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: "sun.max").font(.caption2).foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)
                    Text(L("section.briefing")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                    Spacer(minLength: 4)
                    if let date = structure?.dateLabel {
                        Text(date).font(Theme.Typo.micro).foregroundStyle(Theme.textDim)
                            .lineLimit(1)
                    }
                }
                if let structure {
                    // The day verdict — the one sentence worth reading first.
                    Text(structure.headline)
                        .font(Theme.Typo.head).foregroundStyle(Theme.text)
                        .lineLimit(2).multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if structure.curve.contains(where: { $0 > 0 }) {
                        BriefingSparkline(curve: structure.curve)
                            .frame(height: 22)
                            .accessibilityHidden(true)
                    }
                    BriefingSegmentsRow(segments: structure.segments)
                    if let top = structure.attention.first {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text("\(top.rank)").font(Theme.Typo.micro)
                                .foregroundStyle(Theme.textDim)
                            Text(top.action).font(.caption).foregroundStyle(Theme.text)
                                .lineLimit(1)
                        }
                    }
                } else if let briefing {
                    Text(briefing).font(.caption).foregroundStyle(Theme.text)
                        .lineLimit(3).multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8).padding(.leading, 6)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 1).fill(Theme.accent.opacity(0.7))
                    .frame(width: 2).padding(.vertical, 6)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("briefing.a11y", structure?.headline ?? briefing ?? ""))
    }
}

/// Offscreen render harness: ImageRenderer draws ScrollView content as empty,
/// so `--render-previews` shoots the briefing card directly through this
/// internal wrapper instead of through TodayColumn.
struct BriefingCardRenderProbe: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        BriefingCard(briefing: model.briefing, structure: model.briefingStructure, onOpen: {})
            .padding(12)
    }
}

/// The day's intensity curve — a quiet line that rises where meetings stack.
/// Pure geometry from the server's hourly counts; no animation (it's a fact,
/// not a decoration), so Reduce Motion needs no branch.
private struct BriefingSparkline: View {
    let curve: [Int]

    var body: some View {
        GeometryReader { geo in
            let maxCount = max(curve.max() ?? 1, 1)
            let stepX = geo.size.width / CGFloat(max(curve.count - 1, 1))
            let points = curve.enumerated().map { i, c in
                CGPoint(
                    x: CGFloat(i) * stepX,
                    y: geo.size.height - (CGFloat(c) / CGFloat(maxCount)) * (geo.size.height - 3) - 1.5)
            }
            ZStack {
                Path { path in
                    guard let firstPoint = points.first else { return }
                    path.move(to: firstPoint)
                    for point in points.dropFirst() { path.addLine(to: point) }
                }
                .stroke(Theme.line, lineWidth: 1.5)
                ForEach(Array(points.enumerated()), id: \.offset) { i, point in
                    if curve[i] > 0 {
                        Circle().fill(Theme.accent).frame(width: 3.5, height: 3.5)
                            .position(point)
                    }
                }
            }
        }
    }
}

/// The 2-3 time-segment columns under the sparkline: label + measured summary,
/// hairline-divided. Server-localized text; busy segments carry the accent.
private struct BriefingSegmentsRow: View {
    let segments: [BriefingStructure.Segment]

    var body: some View {
        // Columns where they fit (expanded panel); the 220pt full-mode
        // sidebar can't hold three columns, so it stacks instead.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(segments.enumerated()), id: \.offset) { i, seg in
                    if i > 0 {
                        Rectangle().fill(Theme.line)
                            .frame(width: 1).padding(.vertical, 1)
                            .padding(.horizontal, 7)
                    }
                    cell(seg).frame(minWidth: 76, maxWidth: .infinity, alignment: .leading)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                    cell(seg)
                }
            }
        }
        // Hug content height — otherwise the hairline dividers stretch the
        // row to fill whatever the parent proposes.
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func cell(_ seg: BriefingStructure.Segment) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(seg.label)
                .font(Theme.Typo.micro)
                .foregroundStyle(seg.kind == "busy" ? Theme.accent : Theme.textDim)
            Text(seg.summary)
                .font(.caption2).foregroundStyle(Theme.text)
                .lineLimit(2).multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

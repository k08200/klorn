import SwiftUI

/// Where every empty, error and loading state anchors: 96pt under the
/// header (design detail pass 2026-10-16), never floating mid-window.
enum TodayLayout {
    static let stateAnchorTop: CGFloat = 96
    /// The same anchor inside Today's padded columns.
    static let anchorInColumn: CGFloat = stateAnchorTop - Theme.s6
    /// Lanes and rows per lane the skeleton draws, like a loaded day.
    static let skeletonLanes: [(tier: Tier, rows: Int)] = [(.push, 2), (.meeting, 2), (.queue, 3)]

    // The editorial Today's measures (gen_m1e.py, M1).
    /// The content column's widest.
    static let maxWidth: CGFloat = 1120
    /// The scope + search row at the top of the content card.
    static let topRowHeight: CGFloat = 44
    /// A quiet link ("See all", "N more"): a 28pt target row.
    static let linkHeight: CGFloat = 28
    static let cardMinHeight: CGFloat = 196
    static let cardFace: CGFloat = 32
    static let rowFace: CGFloat = 26
    /// The account ring around a face.
    static let ringWidth: CGFloat = 2
    static let buttonHeight: CGFloat = 28
    /// A compact row: 44pt, the click-target floor.
    static let rowHeight: CGFloat = 44
    static let senderColumn: CGFloat = 96
    static let timeColumn: CGFloat = 52
    static let chipHeight: CGFloat = 20
    static let chipMaxWidth: CGFloat = 220
    /// A schedule entry's colored bar.
    static let eventBar: CGFloat = 3
    /// The timeline's start-time column and its "now" dot.
    static let timelineClock: CGFloat = 40
    static let nowDot: CGFloat = 6
}

/// The loading Today, shaped like the loaded one (M1): the caps line and
/// headline, the PUSH lane as empty cards, then the other skeleton lanes as
/// caps heads over compact rows. Pulses gently unless Reduce Motion is on;
/// still while rendering offscreen.
struct TodaySkeleton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s6) {
            VStack(alignment: .leading, spacing: Theme.s2) {
                bar(width: 220, height: 10)
                bar(width: 300, height: 24)
            }
            ForEach(TodayLayout.skeletonLanes, id: \.tier) { lane in
                if lane.tier == .push {
                    HStack(spacing: Theme.s3) {
                        ForEach(0..<lane.rows, id: \.self) { _ in cardPlaceholder }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        // The lanes are known before the mail is.
                        TodayCaps(text: lane.tier.label).frame(minHeight: TodayLayout.linkHeight)
                        ForEach(0..<lane.rows, id: \.self) { row in
                            rowPlaceholder(row)
                            Rectangle().fill(Theme.todayLine).frame(height: Theme.hairline)
                        }
                    }
                }
            }
            HStack(spacing: Theme.s2) {
                if !Theme.isRenderingOffscreen { ProgressView().controlSize(.small) }
                Text(L("list.firstSync")).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
            }
        }
        .opacity(pulsing ? 0.55 : 1)
        .onAppear {
            guard !reduceMotion, !Theme.isRenderingOffscreen else { return }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                pulsing = true
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("list.firstSync"))
    }

    private var cardPlaceholder: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            HStack(spacing: Theme.s2) {
                Circle().fill(Theme.todayChip).frame(width: TodayLayout.cardFace, height: TodayLayout.cardFace)
                bar(width: 90, height: 9)
            }
            bar(width: 180, height: 14)
            bar(width: 140, height: 10)
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, minHeight: TodayLayout.cardMinHeight, alignment: .topLeading)
        .todayPanel()
    }

    private func rowPlaceholder(_ row: Int) -> some View {
        HStack(spacing: Theme.s3) {
            Circle().fill(Theme.todayChip).frame(width: TodayLayout.rowFace, height: TodayLayout.rowFace)
            bar(width: 80, height: 9)
            bar(width: row.isMultiple(of: 2) ? 280 : 200, height: 9)
            Spacer()
            bar(width: 34, height: 9)
        }
        .frame(maxWidth: .infinity, minHeight: TodayLayout.rowHeight, alignment: .leading)
    }

    private func bar(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: Theme.Radius.chip).fill(Theme.todayChip).frame(width: width, height: height)
    }
}

import SwiftUI

/// Where every empty, error and loading state anchors: 96pt under the
/// header (design detail pass 2026-10-16), never floating mid-window.
enum TodayLayout {
    static let stateAnchorTop: CGFloat = 96
    /// The same anchor inside Today's padded columns.
    static let anchorInColumn: CGFloat = stateAnchorTop - Theme.s6
    /// Lanes and rows per lane the skeleton draws, like a loaded day.
    static let skeletonLanes: [(tier: Tier, rows: Int)] = [(.push, 2), (.meeting, 2), (.queue, 3)]
}

/// The loading Today, shaped like the loaded one: a lane chip and count
/// over a hairline group of rows, three lanes deep. Pulses gently unless
/// Reduce Motion is on; still while rendering offscreen.
struct TodaySkeleton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s6) {
            ForEach(TodayLayout.skeletonLanes, id: \.tier) { lane in
                VStack(alignment: .leading, spacing: Theme.s2) {
                    HStack(spacing: Theme.s2) {
                        // The real chip: the lanes are known before the mail is.
                        WindowLaneChip(tier: lane.tier)
                        bar(width: 16, height: 10)
                    }
                    .padding(.horizontal, Theme.s1)
                    .frame(minHeight: 24)
                    VStack(spacing: 0) {
                        ForEach(0..<lane.rows, id: \.self) { row in
                            if row > 0 {
                                Rectangle().fill(Theme.line).frame(height: Theme.hairline)
                                    .padding(.leading, Theme.s3)
                            }
                            rowPlaceholder(row)
                        }
                    }
                    .todayPanel()
                }
            }
            HStack(spacing: Theme.s2) {
                if !Theme.isRenderingOffscreen { ProgressView().controlSize(.small) }
                Text(L("list.firstSync")).font(Theme.Typo.body).foregroundStyle(Theme.textDim)
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

    private func rowPlaceholder(_ row: Int) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            HStack {
                bar(width: 110, height: 9)
                Spacer()
                bar(width: 34, height: 9)
            }
            bar(width: row.isMultiple(of: 2) ? 320 : 240, height: 11)
        }
        .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
        .frame(maxWidth: .infinity, minHeight: Theme.rowHeight, alignment: .leading)
    }

    private func bar(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: Theme.Radius.sm).fill(Theme.surfaceHover).frame(width: width, height: height)
    }
}

/// The rail while loading: the calendar and assistant cards, empty.
struct TodayRailSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s4) {
            card(title: NavSection.calendar.title, lines: 4)
            card(title: NavSection.assistant.title, lines: 3)
        }
        .accessibilityHidden(true)
    }

    private func card(title: String, lines: Int) -> some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            Text(title).font(Theme.Typo.head).foregroundStyle(Theme.textDim)
            ForEach(0..<lines, id: \.self) { line in
                RoundedRectangle(cornerRadius: Theme.Radius.sm).fill(Theme.surfaceHover)
                    .frame(width: line.isMultiple(of: 2) ? 200 : 150, height: 10)
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .todayPanel()
    }
}

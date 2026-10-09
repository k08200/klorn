import SwiftUI

/// The calendar's month-view measures, by shell. `.bar` holds the bar's
/// values exactly as they were inline; `.window` uses the type roles (no
/// 10pt text) and the control radius.
struct CalendarMetrics {
    let title: Font
    let weekday: Font
    let chip: Font
    let chipRadius: CGFloat
    let scopeRadius: CGFloat
    let headerInset: CGFloat
    let headerVertical: CGFloat

    static let bar = CalendarMetrics(
        title: .title3.weight(.semibold), weekday: Theme.Typo.micro, chip: Theme.Typo.micro,
        chipRadius: 3, scopeRadius: 8, headerInset: 24, headerVertical: 14)

    static let window = CalendarMetrics(
        title: Theme.Typo.title, weekday: Theme.Typo.caption.weight(.medium),
        chip: Theme.Typo.caption, chipRadius: Theme.Radius.sm, scopeRadius: Theme.Radius.sm,
        headerInset: Theme.s6, headerVertical: Theme.s3)

    /// A month row is never shorter than this: the day number and two events.
    static let minMonthRow: CGFloat = 84

    /// The height each week gets when `weeks` of them share `available`
    /// points with a 1pt rule between them. Never under the floor: a short
    /// window cuts the last week instead of crushing every cell. Pure.
    static func monthRowHeight(available: CGFloat, weeks: Int) -> CGFloat {
        guard weeks > 0 else { return minMonthRow }
        let rules = CGFloat(weeks - 1)
        return max(minMonthRow, ((available - rules) / CGFloat(weeks)).rounded(.down))
    }
}

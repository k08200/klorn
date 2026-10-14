import SwiftUI

/// The mail list's header and search-field measures, by shell. `.bar` holds
/// the bar's values exactly as they were inline; `.window` is the design
/// system's (type roles, 6pt control radius, the 4pt spacing grid).
struct MailListMetrics {
    let title: Font
    let titleCount: Font
    let titleIcon: Font
    let field: Font
    let fieldIcon: Font
    let compose: Font
    let inset: CGFloat
    let titleVertical: CGFloat
    let fieldInset: CGFloat
    let fieldVertical: CGFloat
    let fieldRadius: CGFloat
    let fieldGap: CGFloat

    static let bar = MailListMetrics(
        title: .title3.weight(.semibold), titleCount: .title3.monospacedDigit(),
        titleIcon: .body, field: .callout, fieldIcon: .caption,
        compose: .callout.weight(.medium), inset: 24, titleVertical: 18,
        fieldInset: 10, fieldVertical: 7, fieldRadius: 8, fieldGap: 12)

    static let window = MailListMetrics(
        title: Theme.Typo.title, titleCount: Theme.Typo.title.monospacedDigit(),
        titleIcon: Theme.Typo.body, field: Theme.Typo.body, fieldIcon: Theme.Typo.caption,
        compose: Theme.Typo.body, inset: Theme.s4, titleVertical: Theme.s3,
        fieldInset: Theme.s2, fieldVertical: Theme.s2 - Theme.hairline,
        fieldRadius: Theme.Radius.sm, fieldGap: Theme.s2)
}

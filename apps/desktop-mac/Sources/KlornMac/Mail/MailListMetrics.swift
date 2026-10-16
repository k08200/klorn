import SwiftUI

/// The mail list's header and search-field measures: the design system's
/// type roles, 6pt control radius and 4pt spacing grid.
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

    static let window = MailListMetrics(
        title: Theme.Typo.title, titleCount: Theme.Typo.title.monospacedDigit(),
        titleIcon: Theme.Typo.body, field: Theme.Typo.body, fieldIcon: Theme.Typo.caption,
        compose: Theme.Typo.body, inset: Theme.s4, titleVertical: Theme.s3,
        fieldInset: Theme.s2, fieldVertical: Theme.s2 - Theme.hairline,
        fieldRadius: Theme.Radius.sm, fieldGap: Theme.s2)
}

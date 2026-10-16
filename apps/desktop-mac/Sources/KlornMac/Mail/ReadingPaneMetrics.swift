import SwiftUI

/// The reading pane's type, status colors and insets. Each maps to a role
/// of the six-step scale, so nothing in the reader is under 11pt.
struct ReadingPaneMetrics {
    let title3: Font
    let callout: Font
    let caption: Font
    let captionMedium: Font
    let caption2: Font
    let caption2Semibold: Font
    let sender: Font
    let senderInk: Color
    let warning: Color
    let danger: Color
    let success: Color
    let editorRadius: CGFloat
    let cardRadius: CGFloat
    let inset: CGFloat
    let bandVertical: CGFloat
    let stripVertical: CGFloat

    static let window = ReadingPaneMetrics(
        title3: Theme.Typo.head, callout: Theme.Typo.body, caption: Theme.Typo.caption,
        captionMedium: Theme.Typo.caption.weight(.medium), caption2: Theme.Typo.caption,
        caption2Semibold: Theme.Typo.caption.weight(.semibold),
        sender: Theme.Typo.body.weight(.medium), senderInk: Theme.text,
        warning: Theme.warningInk, danger: Theme.danger, success: Theme.success,
        editorRadius: Theme.Radius.md, cardRadius: Theme.Radius.md, inset: Theme.s6,
        bandVertical: Theme.s3, stripVertical: Theme.s2)
}

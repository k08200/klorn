import SwiftUI

/// The reading pane's type, status colors and insets, by shell. `.bar`
/// holds the bar's values exactly as they were inline (system text styles,
/// whose caption is 10pt); `.window` maps each to a role of the six-step
/// scale, so nothing in the main window's reader is under 11pt.
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

    static let bar = ReadingPaneMetrics(
        title3: .title3, callout: .callout, caption: .caption,
        captionMedium: .caption.weight(.medium), caption2: .caption2,
        caption2Semibold: .caption2.weight(.semibold), sender: .callout,
        senderInk: Theme.textDim, warning: .orange, danger: .red, success: .green,
        editorRadius: 12, cardRadius: 8, inset: 24, bandVertical: 14, stripVertical: 10)

    static let window = ReadingPaneMetrics(
        title3: Theme.Typo.head, callout: Theme.Typo.body, caption: Theme.Typo.caption,
        captionMedium: Theme.Typo.caption.weight(.medium), caption2: Theme.Typo.caption,
        caption2Semibold: Theme.Typo.caption.weight(.semibold),
        sender: Theme.Typo.body.weight(.medium), senderInk: Theme.text,
        warning: Theme.warningInk, danger: Theme.danger, success: Theme.success,
        editorRadius: Theme.Radius.md, cardRadius: Theme.Radius.md, inset: Theme.s6,
        bandVertical: Theme.s3, stripVertical: Theme.s2)
}

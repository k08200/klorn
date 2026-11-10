import SwiftUI

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

import SwiftUI

/// One drive row (P12): kind glyph, name, modified date and size, and the
/// SourceBadge (the row's one badge). What activating it does is
/// `FilesRules.openAction`: a Klorn folder is walked into, a Klorn file is
/// downloaded, an external row opens its own https link, anything else is
/// plain text. The name is the source's text, rendered as text only.
struct FileRowView: View {
    let file: DriveFileWire
    /// True while this row's download link is being fetched.
    var preparing = false
    /// The narrow Today panel drops the trailing hint glyph.
    var compact = false
    let activate: () -> Void
    @State private var hovering = false

    private var action: FileOpenAction { FilesRules.openAction(for: file) }

    var body: some View {
        if action == .none {
            content.accessibilityElement(children: .combine)
        } else {
            Button(action: activate) {
                content
                    .background(hovering ? Theme.surfaceHover : .clear)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(preparing)
            .onHover { hovering = $0 }
            .help(hint)
            .accessibilityLabel(a11yLabel)
            .accessibilityHint(hint)
        }
    }

    private var meta: String {
        preparing
            ? L("files.download.preparing")
            : FilesRules.meta(for: file, locale: L10n.activeLocale)
    }

    private var content: some View {
        HStack(spacing: Theme.s3) {
            Image(systemName: FilesRules.icon(for: file))
                .font(Theme.Typo.icon)
                .foregroundStyle(Theme.textDim)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: file.name)
                    .font(Theme.Typo.body).foregroundStyle(Theme.text)
                    .lineLimit(1).truncationMode(.middle)
                if !meta.isEmpty {
                    Text(meta).font(Theme.Typo.caption.monospacedDigit())
                        .foregroundStyle(Theme.textDim).lineLimit(1)
                }
            }
            Spacer(minLength: Theme.s2)
            SourceBadge(provider: file.provider, compact: true)
            if !compact, let glyph = trailingGlyph {
                Image(systemName: glyph)
                    .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                    .frame(width: 14)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, Theme.s3)
        // A clickable row is never under 44pt (WCAG 2.2 target size).
        .frame(maxWidth: .infinity, minHeight: compact ? 44 : Theme.rowHeight, alignment: .leading)
    }

    private var trailingGlyph: String? {
        switch action {
        case .folder: "chevron.right"
        case .download: "arrow.down.to.line"
        case .link: "arrow.up.right"
        case .none: nil
        }
    }

    private var hint: String {
        switch action {
        case .folder: L("files.openFolder", file.name)
        case .download: L("files.download.label", file.name)
        case .link: L("files.opensBrowser")
        case .none: ""
        }
    }

    /// "Q3 plan.pdf, Google account, Oct 15 · 1.5 KB".
    private var a11yLabel: String {
        [file.name, L("source.account.a11y", sourceName(provider: file.provider)), meta]
            .filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// A failed download, said in the web's words. Dismissable.
struct FileDownloadErrorLine: View {
    let kind: FileDownloadError
    let name: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
            Image(systemName: "exclamationmark.triangle").font(Theme.Typo.caption)
                .foregroundStyle(Theme.warningInk).accessibilityHidden(true)
            Text(kind == .busy ? L(kind.rawValue) : L(kind.rawValue, name))
                .font(Theme.Typo.caption).foregroundStyle(Theme.warningInk)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Theme.s1)
            Button(action: dismiss) {
                Image(systemName: "xmark").font(Theme.Typo.caption).iconTarget()
            }
            .buttonStyle(.plain).hoverDim()
            .accessibilityLabel(L("mail.dismiss"))
        }
        .accessibilityElement(children: .contain)
    }
}

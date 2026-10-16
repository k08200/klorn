import SwiftUI

/// Files (productization plan §1, P12): the user's files across every drive
/// source that is on, newest first, read-only. A debounced name search, a
/// folder breadcrumb for the Klorn drive, paging, and a SourceBadge per row.
/// Mounted only while `ClientFlags.files` is on (FD-7).
struct FilesSection: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""

    private var store: FilesStore { model.files }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: NavSection.files.title, detail: L("files.subtitle"))
            Rectangle().fill(Theme.line).frame(height: Theme.hairline)
            VStack(alignment: .leading, spacing: Theme.s3) {
                searchField
                if !store.trail.isEmpty { FolderTrail(store: store) }
                if let error = store.downloadError {
                    FileDownloadErrorLine(kind: error.kind, name: error.name) {
                        store.dismissDownloadError()
                    }
                }
            }
            .padding(.horizontal, Theme.s6).padding(.vertical, Theme.s3)
            Rectangle().fill(Theme.line).frame(height: Theme.hairline)
            if Theme.isRenderingOffscreen {
                // ImageRenderer draws nothing inside a ScrollView.
                Color.clear.overlay(alignment: .topLeading) { list }.clipped()
            } else {
                ScrollView { list }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // Debounced: the list is asked for once typing settles. The first
        // run (empty query) is the initial load.
        .task(id: query) {
            guard !Theme.isRenderingOffscreen else { return }
            if !query.isEmpty {
                try? await Task.sleep(for: FilesRules.searchDebounce)
                guard !Task.isCancelled else { return }
            }
            await store.search(query)
        }
    }

    private var searchField: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: "magnifyingglass").font(Theme.Typo.icon).foregroundStyle(Theme.textDim)
                .accessibilityHidden(true)
            ZStack(alignment: .leading) {
                if Theme.isRenderingOffscreen {
                    Text(store.appliedQuery.isEmpty ? L("files.search.placeholder") : store.appliedQuery)
                        .font(Theme.Typo.body)
                        .foregroundStyle(store.appliedQuery.isEmpty ? Theme.textDim : Theme.text)
                }
                TextField(L("files.search.placeholder"), text: $query)
                    .opacity(Theme.isRenderingOffscreen ? 0 : 1)
                    .textFieldStyle(.plain).font(Theme.Typo.body).foregroundStyle(Theme.text)
                    .accessibilityLabel(L("files.search.label"))
                    .onKeyPress(.escape) {
                        guard !query.isEmpty else { return .ignored }
                        query = ""
                        return .handled
                    }
            }
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(Theme.Typo.icon)
                }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                .accessibilityLabel(L("mail.clearSearch.a11y"))
            }
        }
        .padding(.horizontal, Theme.s3)
        .frame(maxWidth: 420, minHeight: 32)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.sm))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.line))
    }

    @ViewBuilder
    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch store.phase {
            case .idle, .loading:
                FilesSkeleton()
            case .failed:
                VStack(spacing: Theme.s3) {
                    EmptyState(icon: "exclamationmark.triangle", title: L("files.error"), typeRoles: true)
                    Button(L("today.retry")) { Task { await store.reload() } }
                        .buttonStyle(SolidButtonStyle(prominent: false))
                }
                .padding(.vertical, Theme.s12)
            case .loaded:
                if store.files.isEmpty {
                    emptyState.padding(.vertical, Theme.s12)
                } else {
                    rows
                }
            }
        }
        .frame(maxWidth: 1080, alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private var emptyState: some View {
        let (title, hint): (String, String) =
            if !store.appliedQuery.isEmpty {
                (L("files.noMatch.title"), L("files.noMatch.body"))
            } else if store.folder != nil {
                (L("files.folderEmpty.title"), L("files.folderEmpty.body"))
            } else {
                (L("files.empty.title"), L("files.empty.body"))
            }
        return EmptyState(icon: "folder", title: title, hint: hint, typeRoles: true)
    }

    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(store.files) { file in
                FileRowView(file: file, preparing: store.downloadingId == file.id) {
                    Task { await store.open(file) }
                }
                .padding(.horizontal, Theme.s3)
                Rectangle().fill(Theme.line).frame(height: Theme.hairline).padding(.leading, Theme.s6)
            }
            pager.padding(.vertical, Theme.s3)
        }
        // A stale list (a new search on its way) is shown, dimmed.
        .opacity(store.stale ? 0.6 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(store.appliedQuery.isEmpty ? L("today.files.title") : L("files.search.label"))
    }

    @ViewBuilder
    private var pager: some View {
        if store.loadingMore {
            Text(L("files.loadingMore")).font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                .frame(maxWidth: .infinity)
        } else if store.loadMoreFailed {
            HStack(spacing: Theme.s2) {
                Text(L("files.error")).font(Theme.Typo.caption).foregroundStyle(Theme.warningInk)
                Button(L("today.retry")) { Task { await store.loadMore() } }
                    .buttonStyle(SolidButtonStyle(prominent: false, compact: true))
            }
            .frame(maxWidth: .infinity)
        } else if store.hasMore {
            Button(L("files.loadMore")) { Task { await store.loadMore() } }
                .buttonStyle(SolidButtonStyle(prominent: false))
                .frame(maxWidth: .infinity)
        }
    }
}

/// "All files › Projects › 2026": every crumb but the last walks back.
private struct FolderTrail: View {
    let store: FilesStore

    var body: some View {
        HStack(spacing: Theme.s1) {
            crumb(L("files.trail.all"), index: -1, current: false)
            ForEach(Array(store.trail.enumerated()), id: \.element.id) { index, folder in
                Image(systemName: "chevron.right").font(Theme.Typo.caption)
                    .foregroundStyle(Theme.textDim).accessibilityHidden(true)
                crumb(folder.name, index: index, current: index == store.trail.count - 1)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("files.trail.label"))
    }

    @ViewBuilder
    private func crumb(_ title: String, index: Int, current: Bool) -> some View {
        if current {
            Text(verbatim: title).font(Theme.Typo.label).foregroundStyle(Theme.text).lineLimit(1)
                .accessibilityAddTraits(.isSelected)
        } else {
            Button { Task { await store.walk(to: index) } } label: {
                Text(verbatim: title).font(Theme.Typo.label).foregroundStyle(Theme.textDim).lineLimit(1)
                    .frame(minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).hoverDim()
        }
    }
}

/// Rows-shaped placeholders while the first page loads. Static: nothing
/// pulses, so Reduce Motion has nothing to stop.
private struct FilesSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<5, id: \.self) { row in
                HStack(spacing: Theme.s3) {
                    RoundedRectangle(cornerRadius: 3).fill(Theme.surfaceHover).frame(width: 16, height: 16)
                    VStack(alignment: .leading, spacing: Theme.s1) {
                        RoundedRectangle(cornerRadius: 3).fill(Theme.surfaceHover)
                            .frame(width: row.isMultiple(of: 2) ? 260 : 200, height: 11)
                        RoundedRectangle(cornerRadius: 3).fill(Theme.surfaceHover).frame(width: 90, height: 8)
                    }
                    Spacer()
                }
                .padding(.horizontal, Theme.s6)
                .frame(height: Theme.rowHeight)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("files.loading"))
    }
}

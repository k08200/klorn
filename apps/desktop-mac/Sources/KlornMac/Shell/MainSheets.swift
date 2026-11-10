import SwiftUI

/// The main window's modal surfaces (productization plan, macOS M5): the
/// lane guide, the event editor and the connect-time question, each a native
/// sheet on the window instead of a scrim overlay.
enum MainSheet: String, Identifiable, CaseIterable {
    case tierGuide, eventEditor, purposePrompt

    var id: String { rawValue }
}

/// Pure rules for the sheets, pinned by the self-check.
enum MainSheetRules {
    /// A window shows one sheet at a time. The order is the overlays' old
    /// z-order, top first: the guide, then the editor the user just asked
    /// for, then the connect-time question.
    static func active(
        showTierGuide: Bool, showEventEditor: Bool, showPurposePrompt: Bool
    ) -> MainSheet? {
        if showTierGuide { return .tierGuide }
        if showEventEditor { return .eventEditor }
        if showPurposePrompt { return .purposePrompt }
        return nil
    }

    /// The sheet the window should have attached now. A closed window has
    /// none (the pending one is presented when it opens); a miniaturized
    /// window still exists, so its sheet is attached and waiting in the Dock.
    static func presented(active: MainSheet?, windowVisible: Bool, miniaturized: Bool) -> MainSheet? {
        windowVisible || miniaturized ? active : nil
    }

    /// Whether the main window's keys and menus stand down: exactly while a
    /// sheet is up or waiting behind another one. The compose window is not
    /// a sheet and blocks nothing.
    static func blocksSurface(
        showTierGuide: Bool, showEventEditor: Bool, showPurposePrompt: Bool
    ) -> Bool {
        showTierGuide || showEventEditor || showPurposePrompt
    }
}

/// The modal cards' shared chrome inside a native sheet, which supplies its
/// own surface and shadow: the spacing grid's inset and the card's width.
private struct ModalCard: ViewModifier {
    let width: CGFloat

    func body(content: Content) -> some View {
        content.padding(Theme.s6).frame(width: width)
    }
}

extension View {
    func modalCard(width: CGFloat) -> some View {
        modifier(ModalCard(width: width))
    }
}

/// One sheet's content: the card on the panel surface.
struct MainSheetContent: View {
    @Environment(AppModel.self) private var model
    let sheet: MainSheet

    var body: some View {
        card
            .background(Theme.panel)
    }

    @ViewBuilder
    private var card: some View {
        switch sheet {
        case .tierGuide: TierGuide { model.dismissTierGuide() }
        case .eventEditor: CalendarEventEditor()
        case .purposePrompt: PurposePrompt()
        }
    }
}

extension AppModel {
    /// The sheet the main window shows now, nil for none.
    var activeMainSheet: MainSheet? {
        MainSheetRules.active(
            showTierGuide: showTierGuide, showEventEditor: showEventEditor,
            showPurposePrompt: showPurposePrompt)
    }

    /// Dismiss one sheet through the same path its overlay's scrim used.
    func dismiss(_ sheet: MainSheet) {
        switch sheet {
        case .tierGuide: dismissTierGuide()
        case .eventEditor: dismissEventEditor()
        case .purposePrompt: dismissPurposePrompt()
        }
    }
}

/// A sheet's root view, hosted in the sheet window.
struct MainSheetRoot: View {
    let model: AppModel
    let sheet: MainSheet

    var body: some View {
        MainSheetContent(sheet: sheet)
            .environment(model)
            // L() is not observable; rebuild on a language change.
            .id(model.settings.languageRevision)
    }
}

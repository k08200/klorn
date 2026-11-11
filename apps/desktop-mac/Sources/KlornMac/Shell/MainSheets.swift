import SwiftUI

/// The main window's modal surfaces (productization plan, macOS M5): the
/// lane guide, the event editor and the connect-time question, each a native
/// sheet on the window instead of a scrim overlay.
enum MainSheet: String, Identifiable, CaseIterable {
    case tierGuide, eventEditor, purposePrompt, loginItemPrompt

    var id: String { rawValue }
}

/// Pure rules for the sheets, pinned by the self-check.
enum MainSheetRules {
    /// A window shows one sheet at a time. The order is the overlays' old
    /// z-order, top first: the guide, then the editor the user just asked
    /// for, then the connect-time question, then the one-time "Open at
    /// login" question (N5), which waits behind all of them.
    static func active(
        showTierGuide: Bool, showEventEditor: Bool, showPurposePrompt: Bool,
        showLoginItemPrompt: Bool = false
    ) -> MainSheet? {
        if showTierGuide { return .tierGuide }
        if showEventEditor { return .eventEditor }
        if showPurposePrompt { return .purposePrompt }
        if showLoginItemPrompt { return .loginItemPrompt }
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
        showTierGuide: Bool, showEventEditor: Bool, showPurposePrompt: Bool,
        showLoginItemPrompt: Bool = false
    ) -> Bool {
        showTierGuide || showEventEditor || showPurposePrompt || showLoginItemPrompt
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
        case .loginItemPrompt: LoginItemPromptCard()
        }
    }
}

extension AppModel {
    /// The sheet the main window shows now, nil for none.
    var activeMainSheet: MainSheet? {
        MainSheetRules.active(
            showTierGuide: showTierGuide, showEventEditor: showEventEditor,
            showPurposePrompt: showPurposePrompt, showLoginItemPrompt: showLoginItemPrompt)
    }

    /// Dismiss one sheet through the same path its overlay's scrim used.
    func dismiss(_ sheet: MainSheet) {
        switch sheet {
        case .tierGuide: dismissTierGuide()
        case .eventEditor: dismissEventEditor()
        case .purposePrompt: dismissPurposePrompt()
        // Esc on the "Open at login" question is "Not now".
        case .loginItemPrompt: answerLoginItemPrompt(openAtLogin: false)
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

/// The one-time "Open at login" question (N5): "Open at login" is the
/// default button (Return), "Not now" the cancel button (Esc). Nothing is
/// enabled unless the user picks "Open at login".
struct LoginItemPromptCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            Text(L("loginPrompt.title"))
                .font(Theme.Typo.title).foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            Text(L("loginPrompt.body"))
                .font(Theme.Typo.body).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
            if let error = model.loginItemPromptError {
                Text(error)
                    .font(Theme.Typo.caption).foregroundStyle(Theme.warningInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: Theme.s2) {
                Spacer()
                Button(L("loginPrompt.notNow")) { model.answerLoginItemPrompt(openAtLogin: false) }
                    .keyboardShortcut(.cancelAction)
                Button(L("loginPrompt.openAtLogin")) { model.answerLoginItemPrompt(openAtLogin: true) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(PrimaryButtonStyle())
            }
        }
        .modalCard(width: 420)
    }
}

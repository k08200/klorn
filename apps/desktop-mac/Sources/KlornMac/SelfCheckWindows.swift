import AppKit
import Foundation
import SwiftUI

// Self-check for the compose window and the main window's sheets (M5), run
// by `KlornMac --self-check`. Pure rules first, then the model wiring on an
// in-memory model, then source pins. Since M8 the composer is always its
// own window; no scrim overlay is left.

/// Every M5 check, as (name, passed).
@MainActor
func windowSelfChecks(sourceDir: URL) -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let bools = [false, true]

    // MARK: compose window
    func step(signedIn: Bool = true, show: Bool, visible: Bool) -> ComposeWindowRules.Step {
        ComposeWindowRules.step(signedIn: signedIn, showCompose: show, windowVisible: visible)
    }
    check("signed out: the compose window closes and is never shown",
          bools.allSatisfy { show in
              step(signedIn: false, show: show, visible: true) == .close
                  && step(signedIn: false, show: show, visible: false) == .none
          })
    check("discarding asks first only when the draft has content",
          !ComposeWindowRules.confirmsDiscard(to: "", subject: " ", body: "\n")
          && ComposeWindowRules.confirmsDiscard(to: "a@b.example", subject: "", body: "")
          && ComposeWindowRules.confirmsDiscard(to: "", subject: "", body: "x"))
    check("asking for the composer shows it, also when it is already up",
          step(show: true, visible: false) == .show && step(show: true, visible: true) == .show)
    check("putting the composer away closes only a visible window",
          step(show: false, visible: true) == .close && step(show: false, visible: false) == .none)
    check("the compose window refuses to close mid-send",
          !ComposeWindowRules.mayClose(sending: true) && ComposeWindowRules.mayClose(sending: false))
    check("the compose window is a standard resizable window with a floor",
          ComposeWindowRules.styleMask.isSuperset(of: [.titled, .closable, .resizable])
          && ComposeWindowRules.minSize.width <= ComposeWindowRules.defaultSize.width
          && ComposeWindowRules.minSize.height <= ComposeWindowRules.defaultSize.height
          && ComposeWindowRules.frameAutosaveName != MainWindowRules.frameAutosaveName)
    check("the compose window is titled for a new mail or a draft",
          ComposeWindowRules.title(editingDraft: false) == L("compose.title")
          && ComposeWindowRules.title(editingDraft: true) == L("compose.editDraft"))

    // MARK: menus
    // The main window is open with a mail selected, but the compose window
    // is key: nothing may act on the mail behind it.
    var composeKey = MenuState(
        signedIn: true, fullViewOpen: true, mailSurfaceIsKey: true, modalOpen: false, targetTier: .queue,
        emailLoaded: true, readerReplying: false, teamModeAvailable: false, listHasSearchField: true)
    composeKey.mailSurfaceIsKey = MenuRules.mailSurfaceIsKey(mainWindowIsKey: false, mainWindowOpen: true)
    var messageCommands: [MenuCommand] = [.reply, .dismiss]
    messageCommands += Tier.allCases.map { MenuCommand.moveTo($0) }
    check("message commands never act while the compose window is key",
          messageCommands.allSatisfy { !MenuRules.isEnabled($0, in: composeKey) })
    check("compose, find and go stay live from the compose window",
          [MenuCommand.compose, .find, .go(.inbox), .section(.mail)]
              .allSatisfy { MenuRules.isEnabled($0, in: composeKey) })
    func listState(_ menu: MenuState) -> ListKeyState {
        ListKeyState(
            menu: menu, responder: .list, composingText: false, zone: .list, showsRows: true,
            itemCount: 3)
    }
    check("the mail list keys stand down while the compose window is key",
          ListKey.allCases.allSatisfy {
              ListKeyRules.action(for: $0, isRepeat: false, in: listState(composeKey)) == nil
          })

    // MARK: sheets
    check("one sheet at a time, in the overlays' z-order",
          MainSheetRules.active(showTierGuide: true, showEventEditor: true, showPurposePrompt: true) == .tierGuide
          && MainSheetRules.active(showTierGuide: false, showEventEditor: true, showPurposePrompt: true)
              == .eventEditor
          && MainSheetRules.active(showTierGuide: false, showEventEditor: false, showPurposePrompt: true)
              == .purposePrompt
          && MainSheetRules.active(showTierGuide: false, showEventEditor: false, showPurposePrompt: false) == nil)
    check("a sheet blocks the surface exactly while one is up or waiting",
          bools.allSatisfy { guide in
              bools.allSatisfy { editor in
                  bools.allSatisfy { prompt in
                      MainSheetRules.blocksSurface(
                          showTierGuide: guide, showEventEditor: editor, showPurposePrompt: prompt)
                          == (MainSheetRules.active(
                              showTierGuide: guide, showEventEditor: editor, showPurposePrompt: prompt) != nil)
                  }
              }
          })
    check("a sheet attaches only to a window on screen; a pending one waits for it",
          MainSheetRules.presented(active: .tierGuide, windowVisible: true, miniaturized: false) == .tierGuide
          && MainSheetRules.presented(active: .tierGuide, windowVisible: false, miniaturized: false) == nil
          && MainSheetRules.presented(active: nil, windowVisible: true, miniaturized: false) == nil)
    check("a miniaturized window still gets its sheet, so the surface is never blocked with nothing to dismiss",
          MainSheet.allCases.allSatisfy {
              MainSheetRules.presented(active: $0, windowVisible: false, miniaturized: true) == $0
          })
    // Only the compose window is open; the lane guide's flag is still set
    // from a main window that has since been closed (no sheet attached).
    var leftover = composeKey
    leftover.fullViewOpen = false
    leftover.modalOpen = false
    check("a leftover sheet flag never disables New Email, Find or Go",
          [MenuCommand.compose, .find, .go(.inbox), .section(.mail)]
              .allSatisfy { MenuRules.isEnabled($0, in: leftover) })
    var underSheet = composeKey
    underSheet.mailSurfaceIsKey = true
    underSheet.modalOpen = MainSheetRules.blocksSurface(
        showTierGuide: false, showEventEditor: true, showPurposePrompt: false)
    var everyCommand = messageCommands + [.compose, .find, .go(.inbox), .section(.today)]
    everyCommand += NavSection.allCases.map { MenuCommand.section($0) }
    check("a sheet disables every menu command, as the overlays did",
          everyCommand.allSatisfy { !MenuRules.isEnabled($0, in: underSheet) })
    check("a sheet takes the mail list keys, as the overlays did",
          ListKey.allCases.allSatisfy {
              ListKeyRules.action(for: $0, isRepeat: false, in: listState(underSheet)) == nil
          }
          // The same state without the sheet does take them (the pin bites).
          && ListKeyRules.action(for: .j, isRepeat: false, in: listState({
              var open = underSheet
              open.modalOpen = false
              return open
          }())) == .move(1))

    // MARK: model wiring (in-memory model, default settings)
    let model = AppModel(tokenStore: InMemoryTokenStore())
    var notified = 0
    model.onComposePresentationChanged = { notified += 1 }
    model.showCompose = false
    let afterNoop = notified
    model.showCompose = true
    model.showCompose = true
    let afterTwoAsks = notified
    model.showCompose = false
    check("the compose window hears every request and the close, never a no-op",
          afterNoop == 0 && afterTwoAsks == 2 && notified == 3)
    model.composeTo = "a@b.example"
    model.composeBody = "draft"
    model.showCompose = true
    model.showCompose = false
    check("putting the composer away keeps the draft; Discard clears it",
          model.composeTo == "a@b.example" && model.composeBody == "draft" && {
              model.discardComposeDraft()
              return model.composeTo.isEmpty && model.composeBody.isEmpty
          }())
    // Sign-out: the draft belongs to the account that wrote it.
    let leaving = AppModel(tokenStore: InMemoryTokenStore())
    leaving.seedForPreview(firewallJSON: "", emailJSON: "", selectedItemId: nil)
    leaving.composeTo = "a@b.example"
    leaving.composeSubject = "s"
    leaving.composeBody = "draft"
    leaving.seedEditingDraftForCheck(gmailId: "g1", inbox: "li-1")
    leaving.showCompose = true
    var closes = 0
    leaving.onComposePresentationChanged = { if !leaving.showCompose { closes += 1 } }
    leaving.signOut()
    check("sign-out discards the compose draft and the draft it was editing",
          leaving.composeTo.isEmpty && leaving.composeSubject.isEmpty && leaving.composeBody.isEmpty
          && leaving.composeError == nil
          && leaving.editingDraftGmailId == nil && leaving.editingDraftInbox == nil)
    check("sign-out puts the composer away and tells the compose window",
          !leaving.showCompose && closes == 1 && leaving.phase == .signedOut)
    check("an open composer is never a modal over the mail, with or without the main window",
          {
              model.showCompose = true
              let open = model.fullViewModalOpen
              model.showCompose = false
              return !open
          }())
    model.showTierGuide = true
    model.beginNewEvent(at: Date(timeIntervalSince1970: 0))
    let top = model.activeMainSheet
    model.dismiss(.eventEditor)
    check("dismissing a sheet goes through its own model path",
          top == .tierGuide && !model.showEventEditor && model.showTierGuide)
    model.showTierGuide = false

    // MARK: source pins
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    func users(of needle: String) -> [String] {
        files.map(\.lastPathComponent)
            .filter { !$0.hasPrefix("SelfCheck") && text($0).contains(needle) }.sorted()
    }
    let controller = text("ComposeWindow.swift")
    check("M8: no overlay layer is mounted anywhere (the bar's full view is gone)",
          users(of: "FullView" + "Modals").isEmpty && users(of: "FullView" + "(actions:").isEmpty)
    check("the composer draws only in its own window",
          users(of: "ComposePanel(") == ["ComposeWindow.swift", "PreviewRenderWindows.swift"])
    check("only the main window presents sheets, and only the app delegate owns the compose window",
          users(of: "MainSheet" + "Root(model:") == ["MainWindow.swift"]
          && users(of: ".begin" + "Sheet(") == ["MainWindow.swift"]
          && users(of: "ComposeWindow" + "Controller(model:") == ["KlornApp.swift"])
    check("the main window's shell has no overlay layer and no SwiftUI sheet",
          !text("MainShell.swift").contains("FullView" + "Modals()")
          && users(of: ".sheet" + "(").isEmpty)
    check("⌘N opens the compose window alone, never a full view under it",
          text("KlornApp.swift").contains(
              "        case .compose:\n"
                  + "            // The composer is its own window (M5) and needs no full view\n"
                  + "            // under it; ⌘N on an open composer brings it forward.\n"
                  + "            model.showCompose = true\n"))
    check("send stays explicit: ⌘⏎ on the one Send button",
          text("Compose.swift").components(separatedBy: ".keyboardShortcut(.return, modifiers: .command)").count == 2)
    check("the window's Discard Draft goes through the confirming controller, Cancel as the default",
          text("Compose.swift").contains("Button(L(\"compose.discard\"), action: onDiscard)")
          && controller.contains("alert.addButton(withTitle: L(\"compose.cancel\"))\n"
              + "        alert.addButton(withTitle: L(\"compose.discard\")).hasDestructiveAction = true"))
    check("a sheet is re-synced when the main window comes back",
          text("MainWindow.swift").contains("func windowDidDeminiaturize(_ notification: Notification) {\n        syncSheet()")
          && text("MainWindow.swift").contains("model.mainWindowIsKey = true\n        // A sheet asked for"))
    check("in a window, Escape never discards the draft",
          !text("Compose.swift").contains(".keyboardShortcut(.cancelAction)"))
    check("modal cards are sheet content only: no scrim chrome of their own",
          !text("MainSheets.swift").contains(".shadow(")
          && text("TierGuide.swift").components(separatedBy: ".modalCard(width:").count == 3
          && text("CalendarEditor.swift").contains(".modalCard(width: 440)"))
    check("the compose window owns its frame and is reused",
          controller.contains("host.sizingOptions = []") && controller.contains("isReleasedWhenClosed = false")
          && controller.contains("isRestorable = false")
          && controller.contains("setFrameAutosaveName(ComposeWindowRules.frameAutosaveName)"))
    let m5Files = ["ComposeWindow.swift", "MainSheets.swift", "PreviewRenderWindows.swift", "Compose.swift"]
    check("every M5 file exists and stays under 400 lines",
          m5Files.allSatisfy { name in
              let lines = text(name).split(separator: "\n", omittingEmptySubsequences: false).count
              return lines > 1 && lines <= 400
          })
    return results
}

import Foundation
import SwiftUI

// Self-check for the main window's navigation and Today (M4b), run by
// `KlornMac --self-check`. Pure rules first, then the model wiring on an
// in-memory model, then source pins that keep the bar's full view (the
// `macMainWindow`-off path) exactly what it was.

private let navCheckQueueJSON = """
{"tiers":{
  "PUSH":[\(navCheckItems("p", "PUSH", 2))],
  "MEETING":[],
  "QUEUE":[\(navCheckItems("q", "QUEUE", 7))],
  "INFO":[\(navCheckItems("i", "INFO", 3))],
  "SILENT":[\(navCheckItems("s", "SILENT", 4))],"AUTO":[]},
 "summary":{"PUSH":2,"MEETING":0,"QUEUE":20,"INFO":3,"SILENT":4,"AUTO":0,"total":29}}
"""

private func navCheckItems(_ prefix: String, _ tier: String, _ count: Int) -> String {
    (1...count).map { index in
        """
        {"id":"\(prefix)\(index)","source":"email","sourceId":"e","type":"email","title":"t",
         "tier":"\(tier)","priority":1,"surfacedAt":"2026-07-29T08:00:00Z"}
        """
    }.joined(separator: ",")
}

/// Every M4b check, as (name, passed).
@MainActor
func navSelfChecks(sourceDir: URL) -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }

    // MARK: old ListMode → section + facet
    let mailModes: [ListMode] = [
        .inbox, .label(.needsReply), .tier(.push), .tier(.silent), .mailbox(.sent), .waitingOn,
    ]
    check("lanes, labels and folders are Mail facets",
          mailModes.allSatisfy { NavRules.section(for: $0) == .mail })
    check("proposals and commitments move to Assistant",
          NavRules.section(for: .proposals) == .assistant
          && NavRules.section(for: .commitments) == .assistant)
    check("calendar and teams are Calendar",
          NavRules.section(for: .calendar) == .calendar && NavRules.section(for: .teams) == .calendar)
    check("four sections, in the plan's order, no Files without a drive source",
          NavSection.allCases == [.today, .mail, .calendar, .assistant])

    let start = MainNav()
    check("the window opens on Today with QUEUE waiting in Mail",
          start.section == .today && start.lastMailMode == .tier(.queue))
    let afterSent = NavRules.following(.mailbox(.sent), from: start)
    check("a written mail mode brings Mail forward and is remembered",
          afterSent.section == .mail && afterSent.lastMailMode == .mailbox(.sent))
    let afterProposals = NavRules.following(.proposals, from: afterSent)
    check("a proposals deep link lands on Assistant, Approvals pane, mail facet kept",
          afterProposals.section == .assistant && afterProposals.assistantPane == .approvals
          && afterProposals.lastMailMode == .mailbox(.sent))
    check("a commitments deep link lands on the Commitments pane",
          NavRules.following(.commitments, from: start).assistantPane == .commitments)

    check("entering Mail from elsewhere returns to the last mail facet",
          NavRules.listMode(entering: .mail, nav: afterProposals, current: .proposals)
              == .mailbox(.sent))
    check("entering Mail while on a mail facet keeps it",
          NavRules.listMode(entering: .mail, nav: start, current: .label(.customer))
              == .label(.customer))
    check("entering Calendar keeps teams, else shows the calendar",
          NavRules.listMode(entering: .calendar, nav: start, current: .teams) == .teams
          && NavRules.listMode(entering: .calendar, nav: start, current: .inbox) == .calendar)
    check("today and the briefing pane write no list mode",
          NavRules.listMode(entering: .today, nav: start, current: .inbox) == nil
          && NavRules.listMode(for: .briefing) == nil
          && NavRules.listMode(for: .approvals) == .proposals
          && NavRules.listMode(for: .commitments) == .commitments)

    // MARK: lane filter
    check("lane segments are Push, Meeting, Queue, Info, All, with no Silent",
          LaneFilter.allCases.map(\.tier) == [.push, .meeting, .queue, .info, nil])
    check("each lane segment round-trips through its list mode",
          LaneFilter.allCases.allSatisfy {
              NavRules.laneFilter(for: NavRules.listMode(for: $0)) == $0
          })
    check("the All segment is the chronological inbox",
          NavRules.listMode(for: .all) == .inbox)
    check("silenced, folders and labels light no segment",
          NavRules.laneFilter(for: .tier(.silent)) == nil
          && NavRules.laneFilter(for: .mailbox(.drafts)) == nil
          && NavRules.laneFilter(for: .waitingOn) == nil
          && NavRules.laneFilter(for: .label(.billing)) == nil)
    check("show silenced is the silent lane and only that",
          NavRules.showsSilenced(.tier(.silent)) && !NavRules.showsSilenced(.tier(.info))
          && !NavRules.showsSilenced(.inbox))
    check("an item opened from outside lands on a facet that lists it",
          NavRules.mailMode(showing: .push, current: .inbox) == .inbox
          && NavRules.mailMode(showing: .push, current: .tier(.push)) == .tier(.push)
          && NavRules.mailMode(showing: .push, current: .tier(.queue)) == .tier(.push)
          && NavRules.mailMode(showing: .info, current: .mailbox(.sent)) == .tier(.info))
    check("first open: untouched state gets the QUEUE default, a deep link is kept",
          NavRules.initial(listMode: .inbox, nav: start).mode == .tier(.queue)
          && NavRules.initial(listMode: .inbox, nav: start).nav.section == .today
          && NavRules.initial(listMode: .tier(.push), nav: start).mode == .tier(.push)
          && NavRules.initial(listMode: .inbox, nav: NavRules.following(.inbox, from: start)).mode
              == .inbox)
    check("the Mail count never includes Silent",
          NavRules.mailCount { $0 == .silent ? 100 : 1 } == 4)

    // MARK: Today composition
    if let queue = try? JSONDecoder().decode(
        FirewallResponse.self, from: Data(navCheckQueueJSON.utf8))
    {
        let lanes = TodayRules.lanes(queue)
        check("today lists Push, Queue, Info and drops the empty Meeting lane",
              lanes.map(\.tier) == [.push, .queue, .info])
        check("today never shows Silent",
              !lanes.contains { $0.tier == .silent }
              && !lanes.flatMap(\.rows).contains { $0.tier == .silent })
        let push = lanes.first { $0.tier == .push }
        check("today: Push is expanded: every row, nothing left over",
              push?.style == .rows && push?.rows.count == 2 && push?.remaining == 0)
        let laneQueue = lanes.first { $0.tier == .queue }
        check("today: Queue shows the summary count and its top five, in server order",
              laneQueue?.count == 20 && laneQueue?.rows.map(\.id) == ["q1", "q2", "q3", "q4", "q5"]
              && laneQueue?.remaining == 15)
        let info = lanes.first { $0.tier == .info }
        check("today: Info is collapsed to a count",
              info?.style == .collapsed && info?.count == 3 && info?.rows.isEmpty == true)
    } else {
        check("the Today fixture decodes", false)
    }
    check("today: signed out and failed are their own states, never the skeleton",
          TodayRules.state(phase: .signedOut, hasQueue: false, loadError: nil) == .signedOut
          && TodayRules.state(phase: .signedOut, hasQueue: false, loadError: "x") == .signedOut
          && TodayRules.state(phase: .signingIn, hasQueue: false, loadError: nil) == .signingIn
          && TodayRules.state(phase: .signedIn, hasQueue: false, loadError: "x") == .failed("x")
          && TodayRules.state(phase: .signedIn, hasQueue: false, loadError: nil) == .loading)
    check("today: a loaded queue stays on screen through a failed refresh",
          TodayRules.state(phase: .signedIn, hasQueue: true, loadError: "x") == .ready)
    check("today: the briefing line is the headline, else the first plain line",
          TodayRules.briefingLine(structure: nil, briefing: "first\nsecond") == "first"
          && TodayRules.briefingLine(structure: nil, briefing: nil) == nil
          && TodayRules.briefingLine(structure: nil, briefing: "  \n") == nil)
    do {
        func event(_ id: String) -> CalendarEventWire {
            CalendarEventWire(
                id: id, title: id, startTime: "2026-07-29T08:00:00Z",
                endTime: "2026-07-29T09:00:00Z", location: nil, meetingLink: nil, allDay: false)
        }
        let summary = TodaySummary(
            total: 3, current: event("a"), upcoming: [event("a"), event("b")], nextEvent: nil)
        let events = TodayRules.events(summary)
        check("today: the current event leads and is not listed twice",
              events.map(\.event.id) == ["a", "b"] && events.map(\.isNow) == [true, false]
              && TodayRules.events(nil).isEmpty)
    }
    check("source glyphs are the plan's monochrome set",
          sourceMonogram(provider: "GOOGLE") == "G" && sourceMonogram(provider: "naver") == "N"
          && sourceMonogram(provider: "MICROSOFT") == "M" && sourceMonogram(provider: "ICLOUD") == "iC"
          && sourceMonogram(provider: "IMAP") == "IMAP" && sourceMonogram(provider: nil) == "K")

    // MARK: Go menu
    check("main window: the sections take the first four digits",
          NavSection.allCases.map(NavRules.shortcutDigit) == [1, 2, 3, 4])
    check("main window: Approvals keeps a digit, other old targets keep none",
          MenuRules.mainWindowShortcut(for: .go(.proposals)) != nil
          && NavRules.numberedSecondaryDigit == 5
          && NavRules.secondaryDestinations.filter { $0 != .proposals }
              .allSatisfy { MenuRules.mainWindowShortcut(for: .go($0)) == nil })
    check("main window: every old destination is still reachable",
          MenuRules.destinations.allSatisfy { mode in
              NavRules.secondaryDestinations.contains(mode)
                  || mode == .inbox || mode == .calendar
          })
    check("main window: the proposals item reads as the Approvals pane",
          MenuRules.mainWindowTitle(for: .proposals) == AssistantPane.approvals.title
          && MenuRules.mainWindowTitle(for: .waitingOn) == MenuRules.title(for: .waitingOn))
    check("flag off: the Go menu's destinations and digits are the M1 ones",
          MenuRules.destinations == [
              .inbox, .calendar, .proposals, .commitments, .waitingOn,
              .mailbox(.sent), .mailbox(.drafts), .mailbox(.archived), .teams,
          ]
          && [ListMode.inbox, .calendar, .proposals, .commitments, .waitingOn]
              .allSatisfy { MenuRules.shortcut(for: .go($0)) != nil }
          && MenuRules.shortcut(for: .go(.mailbox(.sent))) == nil
          && MenuRules.title(for: .proposals) == L("proposals.title"))
    var menu = MenuState(
        signedIn: true, fullViewOpen: true, mailSurfaceIsKey: true, modalOpen: false,
        targetTier: nil, emailLoaded: false, readerReplying: false, teamModeAvailable: false,
        listHasSearchField: true)
    let sectionOpen = MenuRules.isEnabled(.section(.today), in: menu)
    menu.readerReplying = true
    let sectionHeldByDraft = !MenuRules.isEnabled(.section(.today), in: menu)
    menu.readerReplying = false
    menu.signedIn = false
    check("a section command follows Go: off while signed out or mid-reply",
          sectionOpen && sectionHeldByDraft && !MenuRules.isEnabled(.section(.mail), in: menu))

    // MARK: model wiring (in-memory token store: never the Keychain)
    do {
        let model = AppModel(tokenStore: InMemoryTokenStore())
        let untouched = model.listMode == .inbox && model.mainNav == MainNav()
        model.prepareMainNavigation()
        check("model: first open lands on Today with QUEUE in Mail",
              untouched && model.mainNav.section == .today && model.listMode == .tier(.queue))
        model.navigate(to: .mail)
        check("model: Mail shows the QUEUE lane by default",
              model.mainNav.section == .mail && model.listMode == .tier(.queue))
        model.showLane(.all)
        model.navigate(to: .today)
        check("model: Today keeps the mail facet for the way back",
              model.mainNav.section == .today && model.listMode == .inbox)
        model.go(to: .proposals)
        model.navigate(to: .today)
        // The same list mode again (the pill's "N awaiting approval").
        model.listMode = .proposals
        check("model: a deep link to the mode already set still brings its section forward",
              model.mainNav.section == .assistant && model.mainNav.assistantPane == .approvals)
        model.showAssistantPane(.briefing)
        check("model: the briefing pane stays in Assistant",
              model.mainNav.section == .assistant && model.mainNav.assistantPane == .briefing)
        model.navigate(to: .mail)
        check("model: back in Mail on the facet that was left",
              model.mainNav.section == .mail && model.listMode == .inbox)
        model.go(to: .teams)
        check("model: teams is reached inside Calendar",
              model.mainNav.section == .calendar && model.listMode == .teams)
    }

    // MARK: the Message menu never acts on a mail that is not on screen
    check("reader: always there in the bar's full view, only in Mail in the main window",
          NavSection.allCases.allSatisfy { NavRules.readerVisible(macMainWindow: false, section: $0) }
          && NavRules.readerVisible(macMainWindow: true, section: .mail)
          && [NavSection.today, .calendar, .assistant]
              .allSatisfy { !NavRules.readerVisible(macMainWindow: true, section: $0) })
    check("leaving Mail drops the selection in the main window, never in the bar",
          [NavSection.today, .calendar, .assistant]
              .allSatisfy { NavRules.clearsSelection(macMainWindow: true, section: $0) }
          && !NavRules.clearsSelection(macMainWindow: true, section: .mail)
          && NavSection.allCases
              .allSatisfy { !NavRules.clearsSelection(macMainWindow: false, section: $0) })
    do {
        var onMail = MenuState(
            signedIn: true, fullViewOpen: true, mailSurfaceIsKey: true, modalOpen: false,
            targetTier: .queue, emailLoaded: true, readerReplying: false, teamModeAvailable: false,
            listHasSearchField: true, readerVisible: true)
        let messageCommands: [MenuCommand] = [.reply, .dismiss, .moveTo(.push), .moveTo(.silent)]
        let liveInMail = messageCommands.allSatisfy { MenuRules.isEnabled($0, in: onMail) }
        // The same mail still selected, but the window is on Today.
        onMail.readerVisible = false
        check("open mail, go to Today: Reply, Dismiss and lane moves are off",
              liveInMail && messageCommands.allSatisfy { !MenuRules.isEnabled($0, in: onMail) })
        check("off-screen reader: Compose, Go and the sections stay available",
              MenuRules.isEnabled(.compose, in: onMail) && MenuRules.isEnabled(.go(.inbox), in: onMail)
              && MenuRules.isEnabled(.section(.mail), in: onMail))
    }
    do {
        let model = AppModel(tokenStore: InMemoryTokenStore())
        func openMail() {
            model.seedForPreview(firewallJSON: navCheckQueueJSON, emailJSON: "", selectedItemId: "q1")
            model.go(to: .tier(.queue))
            model.seedForPreview(firewallJSON: navCheckQueueJSON, emailJSON: "", selectedItemId: "q1")
        }
        openMail()
        let targeted = model.menuTargetItem?.id == "q1" && model.mainNav.section == .mail
        model.navigate(to: .today)
        check("model: Mail to Today leaves no selection and no menu target",
              targeted && model.selectedItemId == nil && model.menuTargetItem == nil)
        openMail()
        model.showAssistantPane(.briefing)
        check("model: Mail to the briefing pane leaves no selection",
              model.selectedItemId == nil && model.menuTargetItem == nil)
        openMail()
        model.navigate(to: .assistant)
        check("model: Mail to Assistant leaves no selection",
              model.selectedItemId == nil && model.menuTargetItem == nil)
        openMail()
        model.navigate(to: .mail)
        check("model: staying in Mail keeps the open mail",
              model.selectedItemId == "q1" && model.menuTargetItem?.id == "q1")
        model.navigate(to: .today)
        if let push = model.queue?.items(for: .push).first {
            model.revealInMail(push)
            check("model: a Today row brings Mail forward on a facet that lists it",
                  model.mainNav.section == .mail && model.listMode == .tier(.push))
        } else {
            check("the menu fixture holds a Push item", false)
        }
    }

    check("new integer formats render",
          [L("today.lane.more", 4), L("today.approvals.waiting", 4), L("today.lane.a11y", "x", 4),
           L("a11y.position", 4, 5)]
              .allSatisfy { $0.contains("4") && !$0.contains("%") })
    check("new string formats render",
          L("today.row.a11y", "x", "y").contains("x") && !L("today.row.a11y", "x", "y").contains("%"))

    // MARK: flag-off invariance (source pins)
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    let shell = "Main" + "Shell("
    let shellUsers = files.map(\.lastPathComponent)
        .filter { !$0.hasPrefix("SelfCheck") && text($0).contains(shell) }.sorted()
    check("flag off: only the main window (and its render shots) builds the new shell",
          shellUsers == ["MainWindow.swift", "PreviewRenderNav.swift"])
    check("flag off: the bar's full state is still FullView",
          text("TopBarRoot.swift").contains("case .full: FullView(actions: actions)"))
    let newViews = ["NavSidebar(", "TodayScreen(", "MailSection(", "CalendarSection(", "AssistantSection("]
    let barFiles = [
        "FullView.swift", "Sidebar.swift", "FullList.swift", "TopBarRoot.swift",
        "ExpandedDashboard.swift", "CollapsedPill.swift",
    ]
    check("flag off: no bar surface mounts a main-window view",
          barFiles.allSatisfy { file in !newViews.contains { text(file).contains($0) } })
    check("flag off: shared views default to their pre-M4b behaviour",
          text("ProposalsList.swift").contains("var title = L(\"proposals.title\")")
          && text("FullList.swift").contains("var keyCatcherInRender = true")
          && text("AssistantThread.swift").contains("var inlineWhenOffscreen = false"))
    check("flag off: the model reveals mail in the window only behind the flag",
          text("TopBarController.swift")
              .contains("if model.settings.macMainWindow { model.revealInMail(item) }"))
    // A deep link that writes the list mode (the pill's "awaiting approval"
    // sets .proposals) leaves Mail through the didSet rule, behind the flag.
    let modelSource = text("AppModel.swift")
    check("a list-mode write that leaves Mail drops the selection, behind the flag",
          modelSource.contains("macMainWindow: settings.macMainWindow, section: mainNav.section)")
          && modelSource.contains("guard readerVisible else { return nil }"))
    // Every listMode write moves the main window, so every writer must be
    // user intent. A new writer has to be added here on purpose.
    let assignment = "list" + "Mode = "
    let binding = "$model.list" + "Mode"
    var writers: [String: Int] = [:]
    for file in files.map(\.lastPathComponent)
    where !file.hasPrefix("SelfCheck") && !file.hasPrefix("PreviewRender") {
        let count = text(file).split(separator: "\n").filter { line in
            let code = line.trimmingCharacters(in: .whitespaces)
            return !code.hasPrefix("//") && (code.contains(assignment) || code.contains(binding))
        }.count
        if count > 0 { writers[file] = count }
    }
    check("listMode has only its known, user-driven writers",
          writers == [
              "AppModel.swift": 2,  // go(to:), showTier(_:)
              "TopBarController.swift": 1,  // onOpenProposals
              "MainNav.swift": 2,  // revealInMail(_:), prepareMainNavigation()
              "FullView.swift": 1,  // the bar sidebar's selection binding
          ])
    let m4bFiles = [
        "MainNav.swift", "MainShell.swift", "NavSidebar.swift", "TodayRules.swift",
        "TodayScreen.swift", "TodayPanels.swift", "MailSection.swift", "CalendarSection.swift",
        "AssistantSection.swift", "SegmentedBar.swift", "PreviewRenderNav.swift",
    ]
    check("every M4b file exists and stays under 400 lines",
          m4bFiles.allSatisfy { name in
              let lines = text(name).split(separator: "\n", omittingEmptySubsequences: false).count
              return lines > 1 && lines <= 400
          })
    return results
}

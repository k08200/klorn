import AppKit
import SwiftUI

// Offscreen renderer for design work: `swift run KlornMac --render-previews <dir>`
// writes PNGs of the app's real surfaces without touching the screen.
//
// Screen recording is TCC-blocked on the dev machine, so `screencapture` and
// accessibility scraping both return nothing. ImageRenderer draws the same
// SwiftUI view tree the app draws, so a design change can be seen and compared
// without a human holding a camera to the monitor.
//
// Renders the shipping views, not mock-ups of them: if these look right, the app
// looks right.

@MainActor
enum PreviewRender {
    /// Fixture data dense enough to expose real layout problems — long sender
    /// names, a two-line tier reason, an inbox badge, a full commitments list.
    /// An empty app always looks clean; that is not the state worth designing.
    private static let firewallJSON = """
    {"tiers":{"PUSH":[
      {"id":"p1","source":"email","sourceId":"e1","type":"email","title":"Contract review",
       "tier":"PUSH","tierReason":"You replied to this sender 6 times","priority":9,
       "surfacedAt":"2026-07-29T08:12:00Z",
       "email":{"emailDbId":"d1","subject":"Re: Contract review — needs your sign-off today",
                "from":"Sarah Kim <sarah.kim@northwind-partners.com>",
                "snippet":"Legal came back with two changes on clause 4…",
                "signal":{"kind":"replied","count":6}},"hashStale":false},
      {"id":"p2","source":"email","sourceId":"e2","type":"email","title":"Invoice overdue",
       "tier":"PUSH","tierReason":"Payment due today","priority":8,
       "surfacedAt":"2026-07-29T07:40:00Z",
       "email":{"emailDbId":"d2","subject":"Invoice #4821 is overdue",
                "from":"billing@vendor.io","snippet":"Your invoice was due on 26 July.",
                "signal":{"kind":"first"}},"hashStale":false},
      {"id":"p3","source":"email","sourceId":"e3","type":"email","title":"Sign-off needed",
       "tier":"PUSH","tierReason":"Blocking two people since yesterday","priority":7,
       "surfacedAt":"2026-07-29T07:05:00Z",
       "email":{"emailDbId":"d3","subject":"Waiting on your sign-off to ship",
                "from":"Alex Carter <alex@team.co>","snippet":"We are holding the release until you approve the copy change."},"hashStale":false}],
      "MEETING":[
      {"id":"m1","source":"email","sourceId":"e4","type":"email","title":"Standup moved",
       "tier":"MEETING","tierReason":"Reschedule — no conflict on your calendar","priority":5,
       "surfacedAt":"2026-07-29T07:05:00Z",
       "email":{"emailDbId":"d4","subject":"Standup moved to 10:30",
                "from":"Alex Carter <alex@team.co>","snippet":"Moved tomorrow's standup to 10:30 — still work for you?",
                "signal":{"kind":"replied","count":12}},"hashStale":false}],
      "QUEUE":[
      {"id":"q1","source":"email","sourceId":"e4","type":"email","title":"Weekly digest",
       "tier":"QUEUE","tierReason":"Promotional / marketing sender","priority":3,
       "surfacedAt":"2026-07-29T06:20:00Z",
       "email":{"emailDbId":"d4","subject":"This week in AI tooling — 12 launches",
                "from":"BetaList <hello@betalist.example>","snippet":"Twelve launches worth a look this week.",
                "receivedAt":"2026-07-29T06:18:00Z",
                "signal":{"kind":"category","category":"promotions"}},"hashStale":false}],
      "INFO":[
      {"id":"i1","source":"email","sourceId":"e5","type":"email","title":"Sign-in alert",
       "tier":"INFO","tierReason":"Automated security notice","priority":2,
       "surfacedAt":"2026-07-29T04:05:00Z",
       "email":{"emailDbId":"d5","subject":"New sign-in to your account",
                "from":"OpenAI <noreply@openai.example>","snippet":"A new sign-in was detected on your account.",
                "receivedAt":"2026-07-29T04:04:00Z",
                "signal":{"kind":"category","category":"system"}},"hashStale":false}],
      "SILENT":[],"AUTO":[]},
     "summary":{"PUSH":3,"MEETING":1,"QUEUE":12,"INFO":6,"SILENT":41,"AUTO":0,"total":63}}
    """

    private static let briefingJSON = """
    {"dateLabel":"2026년 8월 22일 토요일",
     "headline":"오전 10시 전에 3건. 나머지는 비어 있습니다.",
     "segments":[
       {"label":"오전 10시 이전","summary":"3건: 싱크, 주간 회의, 벤더 체크인","kind":"busy"},
       {"label":"오전 10시 – 오후 3시","summary":"5시간 비어 있습니다.","kind":"free"},
       {"label":"오후 3시 이후","summary":"1건: 파트너 콜","kind":"busy"}],
     "curve":[1,3,0,0,0,0,0,1,0,0,0,0],
     "dayStartHour":8,
     "attention":[{"rank":1,"action":"회고 생각 두세 가지 준비","reason":"오후 2시 디자인 회고"}]}
    """

    private static let calendarSeedJSON = """
    [{"id":"c1","title":"디자인 회고","startTime":"2026-07-29T05:00:00Z",
      "endTime":"2026-07-29T06:00:00Z","location":null,"meetingLink":null,"allDay":false},
     {"id":"c2","title":"벤더 체크인","startTime":"2026-07-29T07:30:00Z",
      "endTime":"2026-07-29T08:00:00Z","location":null,
      "meetingLink":"https://meet.example/x","allDay":false},
     {"id":"c3","title":"주간 계획","startTime":"2026-07-27T00:30:00Z",
      "endTime":"2026-07-27T01:00:00Z","location":null,"meetingLink":null,"allDay":false},
     {"id":"c4","title":"파트너 콜","startTime":"2026-07-31T08:00:00Z",
      "endTime":"2026-07-31T09:00:00Z","location":null,"meetingLink":null,"allDay":false},
     {"id":"c5","title":"오프사이트","startTime":"2026-07-24T00:00:00Z",
      "endTime":"2026-07-25T00:00:00Z","location":null,"meetingLink":null,"allDay":true},
     {"id":"c6","title":"워크숍","startTime":"2026-07-30T00:00:00Z",
      "endTime":"2026-08-01T00:00:00Z","location":"강릉","meetingLink":null,"allDay":true}]
    """

    private static let emailJSON = """
    {"id":"d1","from":"Sarah Kim <sarah.kim@northwind-partners.com>",
     "subject":"Re: Contract review — needs your sign-off today",
     "date":"2026-07-29T08:12:00Z",
     "summary":"Legal returned two changes to clause 4 and needs your sign-off before 17:00 so the counterparty can countersign today.",
     "needsReply":true,"needsReplyReason":"Sign-off requested with a deadline",
     "text":"Hi,\\n\\nLegal came back with two changes on clause 4 — the indemnity cap and the notice period. Both are minor but they need your sign-off before 17:00 today so the counterparty can countersign.\\n\\nI've attached the redline. Happy to walk through it if easier.\\n\\nBest,\\nSarah",
     "engagement":{"outboundCount":6,"learnedImportance":0.92}}
    """

    static func run(outputDir: String) -> Bool {
        Theme.isRenderingOffscreen = true
        // `-klorn.appearance dark` renders the token set the dark desktop
        // actually shows — chrome decisions must be judged in both modes.
        // NSApplication.appearance alone is not honored by ImageRenderer, so
        // the SwiftUI colorScheme environment is forced too (below).
        let renderDark = UserDefaults.standard.string(forKey: "klorn.appearance") == "dark"
        NSApplication.shared.appearance = NSAppearance(named: renderDark ? .darkAqua : .aqua)
        let dir = URL(fileURLWithPath: outputDir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let model = AppModel()
        model.seedForPreview(
            firewallJSON: firewallJSON,
            emailJSON: emailJSON,
            selectedItemId: "p1",
            briefingJSON: briefingJSON)
        GuideSeen.value = true
        model.showAssistantDock = true
        // The reading shot sells the analysis band — shoot it expanded (the
        // in-app default is collapsed so the mail stays the star).
        // `-klorn.readingBand collapsed` shoots the in-app default instead.
        model.settings.readingBandExpanded =
            UserDefaults.standard.string(forKey: "klorn.readingBand") != "collapsed"
        // JSON like every other fixture — the L10n guard treats Swift string
        // literals as UI copy, and these are demo DATA, not copy.
        if let seed = try? JSONDecoder().decode(
            [CalendarEventWire].self, from: Data(calendarSeedJSON.utf8))
        {
            model.seedCalendarForRender(seed)
        }
        // Folder counts in the sidebar + a populated Sent list for its shot.
        model.seedMailboxForRender(.sent, items: [
            MailboxItem(
                gmailId: "s1", threadId: nil,
                subject: "Re: Contract review — needs your sign-off today",
                from: "you@company.com", to: "Sarah Kim <sarah.kim@northwind-partners.com>",
                snippet: "Signed and attached. Clause 4 reads fine after legal's change.",
                receivedAt: "2026-07-29T05:40:00Z", isRead: true, inbox: "primary"),
            MailboxItem(
                gmailId: "s2", threadId: nil,
                subject: "Q3 numbers for the board deck",
                from: "you@company.com", to: "Priya Patel <priya@company.com>",
                snippet: "Final revenue table attached — the churn note is on slide 9.",
                receivedAt: "2026-07-28T09:12:00Z", isRead: true, inbox: "primary"),
            MailboxItem(
                gmailId: "s3", threadId: nil,
                subject: "Intro: Alex ↔ Jamie",
                from: "you@company.com", to: "Alex Carter <alex@team.co>",
                snippet: "Jamie runs infra at Northwind — you two should talk. Moving you both to bcc.",
                receivedAt: "2026-07-25T18:03:00Z", isRead: true, inbox: "primary"),
        ])
        model.seedMailboxForRender(.drafts, items: [
            MailboxItem(
                gmailId: "dr1", threadId: nil,
                subject: "Q3 vendor consolidation",
                from: "you@company.com", to: "billing@vendor.io",
                snippet: "Before we renew, can you break the invoice into",
                receivedAt: "2026-07-29T03:12:00Z", isRead: true, inbox: "primary"),
        ])
        model.seedMailboxForRender(.archived, items: [
            MailboxItem(
                gmailId: "ar1", threadId: nil,
                subject: "Your July invoice is available",
                from: "billing@saas.example", to: "you@company.com",
                snippet: "Invoice #4783 for July is attached. No action needed.",
                receivedAt: "2026-07-28T22:05:00Z", isRead: true, inbox: "primary"),
        ])

        var ok = true
        // A view taller than the frame is centred by default, which silently cuts
        // the title off the top. Surfaces that read top-down pass .top.
        func shot(_ name: String, size: CGSize, align: Alignment = .center,
                  @ViewBuilder _ content: () -> some View) {
            // .background LAST would sit OUTSIDE the forced colorScheme and
            // paint the light ground behind a dark render — the shot has to
            // carry the environment all the way out.
            let view = content()
                .environment(model)
                .frame(width: size.width, height: size.height, alignment: align)
                .clipped()
                .background(Theme.bg)
                .environment(\.colorScheme, renderDark ? .dark : .light)
            let renderer = ImageRenderer(content: view)
            // 2x so type rendering is judged at the density a Mac actually shows.
            renderer.scale = 2
            guard let image = renderer.nsImage,
                  let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:])
            else {
                print("  ✗ \(name) — render failed")
                ok = false
                return
            }
            let out = dir.appendingPathComponent("\(name).png")
            do {
                try png.write(to: out)
                print("  ✓ \(name)  \(Int(size.width))×\(Int(size.height))")
            } catch {
                print("  ✗ \(name) — \(error.localizedDescription)")
                ok = false
            }
        }

        let actions = previewActions()

        print("Rendering previews to \(dir.path):")
        shot("assistant-dock", size: CGSize(width: 440, height: 560), align: .bottomTrailing) {
            AssistantDockRenderProbe()
        }
        shot("compose", size: CGSize(width: 600, height: 470), align: .top) {
            ComposePanelRenderProbe()
        }
        shot("briefing", size: CGSize(width: 380, height: 260), align: .top) {
            BriefingCardRenderProbe()
        }
        // The narrowest real embedding (full-mode sidebar is 220pt wide) —
        // the card must survive it, not just the roomy probe.
        shot("briefing-narrow", size: CGSize(width: 220, height: 340), align: .top) {
            BriefingCardRenderProbe()
        }
        shot("full", size: TopBarMetrics.size(for: .full)) {
            TopBarRoot(state: .full, actions: actions)
        }
        shot("expanded", size: TopBarMetrics.size(for: .expanded)) {
            TopBarRoot(state: .expanded, actions: actions)
        }
        shot("collapsed", size: CGSize(
            width: TopBarMetrics.size(for: .collapsed).width + 80,
            height: TopBarMetrics.size(for: .collapsed).height + 40)) {
            TopBarRoot(state: .collapsed, actions: actions)
        }
        // ImageRenderer draws nothing inside a ScrollView, so the mail rows —
        // the densest and most design-critical surface in the app — are composed
        // directly here instead of being lost inside the list's scroller.
        // The landing shows these four surfaces in one frame, so they share a
        // width — but each is rendered at the height its own content needs and
        // trimmed to the frame afterwards. Rendering straight into a short frame
        // COMPRESSES the layout instead of overflowing it: at 330pt the option
        // rows in Preferences squeezed until their text sat outside the cards.
        let tourW: CGFloat = 520
        shot("rows", size: CGSize(width: tourW, height: 430), align: .top) {
            VStack(spacing: 0) {
                ForEach(model.queue?.items(for: .push) ?? []) { item in
                    FullRow(item: item, actions: actions)
                    Divider().overlay(Theme.line).padding(.leading, 24)
                }
                Spacer(minLength: 0)
            }
        }
        // The Sent folder — proof the standard-folder shell exists, in the
        // same row grammar as the firewall list.
        shot("mailbox-sent", size: CGSize(width: tourW, height: 430), align: .top) {
            MailboxList(box: .sent)
        }
        // The real calendar — month grid, fixture month pinned.
        shot("calendar", size: CGSize(width: 760, height: 560), align: .top) {
            CalendarScreen(
                actions: actions, initialScope: .month,
                initialAnchor: ISO8601DateFormatter().date(from: "2026-07-29T03:00:00Z") ?? Date())
        }
        // Week view — seven columns, the spanning 워크숍 on two of them.
        shot("calendar-week", size: CGSize(width: 760, height: 460), align: .top) {
            CalendarScreen(
                actions: actions, initialScope: .week,
                initialAnchor: ISO8601DateFormatter().date(from: "2026-07-29T03:00:00Z") ?? Date())
        }
        // The mail level of the two-level sidebar — Back / Compose / folders /
        // categories. Shot with the level flipped, then restored so the full
        // shot above stays the ROOT (first-open) state.
        model.sidebarLevel = .mail
        shot("full-mail", size: TopBarMetrics.size(for: .full)) {
            FullView(actions: actions)
        }
        model.sidebarLevel = .root
        // The reading pane on its own. Shrinking the whole 1400pt window into a
        // landing-page card renders the app's body text at under 7px; this fits
        // the same card at over 100%, so it can actually be read.
        shot("reading", size: CGSize(width: tourW, height: 430), align: .top) {
            ReadingPane(actions: actions)
        }
        // PreferencesView puts its body in a ScrollView, which ImageRenderer
        // draws as nothing — the shot was a title bar over a blank sheet. Render
        // the behaviour settings themselves, which is the part worth showing.
        shot("preferences", size: CGSize(width: tourW, height: 900), align: .top) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(L("prefs.title")).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                    Spacer()
                    Button(L("prefs.done")) {}.buttonStyle(PrimaryButtonStyle())
                }
                .padding(.bottom, 10)
                AutomationPreferences()
            }
            .padding(22)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line))
            .padding(14)
        }
        shot("tier-guide", size: CGSize(width: tourW, height: 520)) {
            TierGuide {}
        }
        return ok
    }

    /// No-op actions: the renderer never interacts, and a fixture must not be
    /// able to fire a real network call.
    private static func previewActions() -> TopBarActions {
        TopBarActions(
            onExpand: {}, onExpandFull: {}, onRestore: {}, onCollapse: {}, onClose: {},
            onSignIn: {}, onSignOut: {},
            onOpenInApp: { _ in }, onOpenTier: { _ in }, onOpenFull: {}, onOpenProposals: {},
            onDismiss: { _ in }, onSnooze: { _, _ in }, onSetTier: { _, _ in },
            onPinSender: { _, _ in }, onUnpinSender: { _ in },
            onSelect: { _ in }, onOpenPreferences: {}, onHideBar: {}, onQuit: {})
    }
}

import AppKit
import SwiftUI

// Offscreen shots of the main window's sections (M4b), part of
// `--render-previews`. Fixture DATA lives in JSON like the other shots; the
// views are the shipping ones (`MainShell`), on their own in-memory model.

extension PreviewRender {
    private static let navFirewallJSON = """
    {"tiers":{"PUSH":[
      {"id":"p1","source":"email","sourceId":"e1","type":"email","title":"Contract review",
       "tier":"PUSH","tierReason":"You replied to this sender 6 times","priority":9,
       "surfacedAt":"2026-07-29T08:12:00Z",
       "email":{"emailDbId":"d1","replyState":"needsReply","subject":"Re: Contract review — needs your sign-off today",
                "from":"Sarah Kim <sarah.kim@northwind-partners.com>","receivedAt":"2026-07-29T08:12:00Z"},"hashStale":false},
      {"id":"p2","source":"email","sourceId":"e2","type":"email","title":"Invoice overdue",
       "tier":"PUSH","tierReason":"Payment due today","priority":8,"surfacedAt":"2026-07-29T07:40:00Z",
       "email":{"emailDbId":"d2","subject":"Invoice #4821 is overdue",
                "from":"billing@vendor.io","receivedAt":"2026-07-29T07:40:00Z"},"hashStale":false},
      {"id":"p3","source":"email","sourceId":"e3","type":"email","title":"Sign-off needed",
       "tier":"PUSH","tierReason":"Blocking two people since yesterday","priority":7,
       "surfacedAt":"2026-07-29T07:05:00Z",
       "email":{"emailDbId":"d3","replyState":"needsReply","draftReady":true,"subject":"Waiting on your sign-off to ship",
                "from":"Alex Carter <alex@team.co>","receivedAt":"2026-07-29T07:05:00Z"},"hashStale":false}],
      "MEETING":[
      {"id":"m1","source":"email","sourceId":"e4","type":"email","title":"Standup moved",
       "tier":"MEETING","tierReason":"Reschedule, no conflict on your calendar","priority":5,
       "surfacedAt":"2026-07-29T06:50:00Z",
       "email":{"emailDbId":"d4","subject":"Standup moved to 10:30",
                "from":"Alex Carter <alex@team.co>","receivedAt":"2026-07-29T06:50:00Z"},"hashStale":false},
      {"id":"m2","source":"email","sourceId":"e5","type":"email","title":"Board prep",
       "tier":"MEETING","tierReason":"Invitation for Thursday, one conflict","priority":5,
       "surfacedAt":"2026-07-29T05:31:00Z",
       "email":{"emailDbId":"d5","subject":"Invitation: Q3 board prep, Thursday 14:00",
                "from":"Priya Patel <priya@northwind.io>","receivedAt":"2026-07-29T05:31:00Z"},"hashStale":false}],
      "QUEUE":[
      {"id":"q1","source":"email","sourceId":"e6","type":"email","title":"Design review notes",
       "tier":"QUEUE","tierReason":"A colleague, no deadline","priority":4,"surfacedAt":"2026-07-29T06:20:00Z",
       "email":{"emailDbId":"d6","subject":"Notes from the onboarding design review",
                "from":"Jamie Ortiz <jamie@team.co>","snippet":"Three open questions from this morning.",
                "receivedAt":"2026-07-29T06:20:00Z","signal":{"kind":"category","category":"internal"}},"hashStale":false},
      {"id":"q2","source":"email","sourceId":"e7","type":"email","title":"Renewal quote",
       "tier":"QUEUE","tierReason":"Vendor quote, renewal is next month","priority":4,
       "surfacedAt":"2026-07-29T05:58:00Z",
       "email":{"emailDbId":"d7","subject":"Your renewal quote for 2027",
                "from":"Dana Whitfield <dana@datahost.example>","snippet":"Attached is the quote we discussed.",
                "receivedAt":"2026-07-29T05:58:00Z","signal":{"kind":"replied","count":3}},"hashStale":false},
      {"id":"q3","source":"email","sourceId":"e8","type":"email","title":"Candidate packet",
       "tier":"QUEUE","tierReason":"Recruiting thread you follow","priority":3,"surfacedAt":"2026-07-29T05:12:00Z",
       "email":{"emailDbId":"d8","subject":"Candidate packet: senior backend engineer",
                "from":"Morgan Lee <morgan@team.co>","snippet":"Interview loop is Friday.",
                "receivedAt":"2026-07-29T05:12:00Z","signal":{"kind":"category","category":"internal"}},"hashStale":false},
      {"id":"q4","source":"email","sourceId":"e9","type":"email","title":"Customer question",
       "tier":"QUEUE","tierReason":"Customer question, not urgent","priority":3,"surfacedAt":"2026-07-29T04:44:00Z",
       "email":{"emailDbId":"d9","subject":"Question about export limits on the team plan",
                "from":"Lena Fischer <lena@brightlabs.example>","snippet":"We hit the cap twice last week.",
                "receivedAt":"2026-07-29T04:44:00Z","signal":{"kind":"category","category":"customer"}},"hashStale":false},
      {"id":"q5","source":"email","sourceId":"e10","type":"email","title":"Offsite logistics",
       "tier":"QUEUE","tierReason":"Planning thread, reply by Friday","priority":3,"surfacedAt":"2026-07-29T03:30:00Z",
       "email":{"emailDbId":"d10","subject":"Offsite logistics: rooms and travel",
                "from":"Noor Haddad <noor@team.co>","snippet":"Please confirm your dates.",
                "receivedAt":"2026-07-29T03:30:00Z"},"hashStale":false},
      {"id":"q6","source":"email","sourceId":"e11","type":"email","title":"Weekly digest",
       "tier":"QUEUE","tierReason":"Newsletter you open most weeks","priority":2,"surfacedAt":"2026-07-29T02:10:00Z",
       "email":{"emailDbId":"d11","subject":"This week in developer tooling",
                "from":"BetaList <hello@betalist.example>","snippet":"Twelve launches worth a look.",
                "receivedAt":"2026-07-29T02:10:00Z","signal":{"kind":"category","category":"promotions"}},"hashStale":false}],
      "INFO":[
      {"id":"i1","source":"email","sourceId":"e12","type":"email","title":"Sign-in alert",
       "tier":"INFO","tierReason":"Automated security notice","priority":2,"surfacedAt":"2026-07-29T04:05:00Z",
       "email":{"emailDbId":"d12","subject":"New sign-in to your account",
                "from":"OpenAI <noreply@openai.example>","receivedAt":"2026-07-29T04:04:00Z"},"hashStale":false}],
      "SILENT":[],"AUTO":[]},
     "summary":{"PUSH":3,"MEETING":2,"QUEUE":14,"INFO":9,"SILENT":41,"AUTO":0,"total":69}}
    """

    private static let navEmptyFirewallJSON = """
    {"tiers":{"PUSH":[],"MEETING":[],"QUEUE":[],"INFO":[],"SILENT":[],"AUTO":[]},
     "summary":{"PUSH":0,"MEETING":0,"QUEUE":0,"INFO":0,"SILENT":12,"AUTO":0,"total":12}}
    """

    private static let navEmailJSON = """
    {"id":"d6","from":"Jamie Ortiz <jamie@team.co>",
     "subject":"Notes from the onboarding design review",
     "date":"2026-07-29T06:20:00Z",
     "summary":"Three open questions from the onboarding review: the account step order, the empty Today state, and who owns the copy pass.",
     "needsReply":false,
     "text":"Hi,\\n\\nNotes from this morning's review. Three things are still open:\\n\\n1. Whether the account step comes before or after the lane guide.\\n2. What Today shows before the first sync finishes.\\n3. Who owns the copy pass.\\n\\nNothing here is urgent. I'll collect answers on Thursday.\\n\\nJamie",
     "engagement":{"outboundCount":3,"learnedImportance":0.61}}
    """

    private static let navBriefingJSON = """
    {"dateLabel":"Wednesday, July 29",
     "headline":"A clear morning, then four meetings from 17:00. The contract sign-off is the one thing with a deadline today.",
     "segments":[
       {"label":"Before 12:00","summary":"3 meetings","kind":"busy"},
       {"label":"12:00 to 17:00","summary":"5 hours free","kind":"free"},
       {"label":"After 17:00","summary":"1 call","kind":"busy"}],
     "curve":[1,2,1,0,0,0,0,0,0,1,0,0],
     "dayStartHour":8,
     "attention":[{"rank":1,"action":"Sign off on the contract before 17:00","reason":"Counterparty countersigns today"}]}
    """

    private static let navTodayJSON = """
    {"total":4,
     "current":{"id":"t1","title":"Weekly planning","startTime":"2026-07-29T08:00:00Z",
                "endTime":"2026-07-29T09:00:00Z","location":null,"meetingLink":"https://meet.example/plan","allDay":false},
     "upcoming":[
       {"id":"t2","title":"Standup","startTime":"2026-07-29T09:30:00Z","endTime":"2026-07-29T09:45:00Z",
        "location":null,"meetingLink":"https://meet.example/standup","allDay":false},
       {"id":"t3","title":"Design review","startTime":"2026-07-29T10:00:00Z","endTime":"2026-07-29T11:00:00Z",
        "location":null,"meetingLink":null,"allDay":false},
       {"id":"t4","title":"Partner call","startTime":"2026-07-29T11:30:00Z","endTime":"2026-07-29T12:00:00Z",
        "location":null,"meetingLink":null,"allDay":false,"readOnly":true,"sourceLabel":"you@naver.example"}],
     "nextEvent":null}
    """

    private static let navInboxesJSON = """
    [{"id":null,"email":"you@company.example","kind":"primary","needsReconnect":false,"provider":"GOOGLE","purpose":"work"},
     {"id":"li-1","email":"you@naver.example","kind":"linked","needsReconnect":false,"provider":"NAVER","purpose":"personal"},
     {"id":"li-2","email":"side-project@outlook.example","kind":"linked","needsReconnect":true,"provider":"MICROSOFT","purpose":"mixed"}]
    """

    private static let navActionsJSON = """
    [{"id":"a1","toolName":"send_email","targetLabel":"Reply to Sarah Kim: signed contract attached",
      "reasoning":"You approved the same clause last week and the deadline is today.","createdAt":"2026-07-29T08:20:00Z"},
     {"id":"a2","toolName":"create_calendar_event","targetLabel":"Q3 board prep, Thursday 14:00 to 15:00",
      "reasoning":"The invitation fits your calendar after moving one focus block.","createdAt":"2026-07-29T05:40:00Z"}]
    """

    private static let navCommitmentsJSON = """
    [{"id":"k1","title":"Send the revised quote","owner":"ME","counterpartyName":"Dana Whitfield",
      "counterpartyEmail":null,"dueText":"Friday","status":"OPEN"},
     {"id":"k2","title":"Q3 numbers for the board deck","owner":"COUNTERPARTY","counterpartyName":"Priya Patel",
      "counterpartyEmail":null,"dueText":null,"status":"OPEN"}]
    """

    private static let navChatJSON = """
    ["What needs me before noon?",
     "**Two things.** The contract sign-off for Sarah Kim is due by 17:00, and a reply is already drafted. Alex is holding the release for your approval on the copy change. Everything else can wait until after the design review."]
    """

    private static func decoded<T: Decodable>(_ type: T.Type, _ json: String) -> T? {
        try? JSONDecoder().decode(type, from: Data(json.utf8))
    }

    /// A signed-in model holding the main-window fixtures.
    private static func navModel(firewallJSON: String, loadError: String? = nil) -> AppModel {
        // Never the default store: see `run`.
        let model = AppModel(tokenStore: InMemoryTokenStore())
        model.seedForPreview(
            firewallJSON: firewallJSON, emailJSON: navEmailJSON, selectedItemId: "q1",
            briefingJSON: navBriefingJSON)
        let chat = decoded([String].self, navChatJSON) ?? []
        model.seedMainWindowForRender(
            inboxes: decoded([InboxOption].self, navInboxesJSON) ?? [],
            today: decoded(TodaySummary.self, navTodayJSON),
            pendingActions: decoded([PendingActionsResponse.Action].self, navActionsJSON) ?? [],
            commitments: decoded([CommitmentItem].self, navCommitmentsJSON) ?? [],
            chat: chat.enumerated().map { index, text in
                ChatMessage(role: index.isMultiple(of: 2) ? .user : .assistant, text: text)
            },
            loadError: loadError)
        if let seed = decoded([CalendarEventWire].self, calendarSeedJSON) {
            model.seedCalendarForRender(seed)
        }
        return model
    }

    static func renderMainWindow(dir: URL, dark: Bool, actions: TopBarActions) -> Bool {
        let size = CGSize(width: 1280, height: 800)
        let date = ISO8601DateFormatter().date(from: "2026-07-29T08:30:00Z") ?? Date()
        var ok = true
        func shot(_ name: String, _ model: AppModel, _ prepare: (AppModel) -> Void = { _ in }) {
            prepare(model)
            ok = writeShot(name, size: size, align: .top, model: model, dir: dir, dark: dark) {
                MainShell(actions: actions, renderDate: date)
            } && ok
        }

        let model = navModel(firewallJSON: navFirewallJSON)
        shot("today", model) { $0.navigate(to: .today) }
        shot("mail-lanes", model) { $0.listMode = NavRules.defaultMailMode }
        shot("calendar-full", model) { $0.listMode = .calendar }
        shot("assistant", model) { $0.showAssistantPane(.approvals) }

        // The states that are not "ready": each must say what it is.
        shot("today-empty", navModel(firewallJSON: navEmptyFirewallJSON))
        shot("today-loading", navModel(firewallJSON: ""))
        shot("today-error", navModel(firewallJSON: "", loadError: "The server did not respond (timed out after 30 s)."))
        shot("today-signed-out", AppModel(tokenStore: InMemoryTokenStore()))
        return ok
    }
}

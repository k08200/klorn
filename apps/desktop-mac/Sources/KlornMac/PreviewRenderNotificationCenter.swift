import SwiftUI

// Offscreen shots of the toolbar bell's floating panel (NC2-A): every group,
// both reason styles (a verified quote, Klorn's judgment), a held row, a
// meeting with a join link, a PENDING proposal and a done row. Fixture DATA,
// not copy: the self-check decodes the same JSON.
extension PreviewRender {
    /// The bell rows. "d1" is a mail the nav fixture's queue holds, so that
    /// row gets a face ringed in its account color plus Reply and Later.
    static let notificationFixtureJSON = """
    {"notifications":[
      {"id":"n1","type":"email","title":"Urgent email","message":"Sarah Kim: Re: Contract review [18c3a]",
       "isRead":false,"link":"/email/d1","sourceEmailId":"d1","pendingActionId":null,"pendingActionStatus":null,
       "createdAt":"2026-07-29T08:27:00Z","lane":"PUSH",
       "reason":{"text":"Signature deadline today","verified":true,"quote":"Please sign before 17:00 today so legal can file.","quoteIn":"body"},
       "deliveredTo":["mac","chrome"]},
      {"id":"n2","type":"email","title":"Urgent email","message":"Ops Alerts: Payment failed for invoice #4821 [18c3b]",
       "isRead":false,"link":"/email/x2","sourceEmailId":"x2","createdAt":"2026-07-29T08:12:00Z","lane":"PUSH",
       "reason":{"text":"Looks like a failed-payment notice, so it was ranked urgent","verified":false},
       "held":true,"deliveredTo":["mac"]},
      {"id":"n3","type":"agent_proposal","title":"Draft ready for approval","message":"Re: invoice #4821 — reply to billing@vendor.io",
       "isRead":false,"pendingActionId":"pa1","pendingActionStatus":"PENDING","createdAt":"2026-07-29T07:58:00Z"},
      {"id":"n4","type":"meeting","title":"Design review · 15:00","message":"Starts in 10 min · Google Meet",
       "isRead":false,"link":"https://meet.google.com/abc-defg-hij","createdAt":"2026-07-29T05:50:00Z","lane":"MEETING",
       "reason":{"text":"Calendar reminder 10 minutes before the start","verified":false},"deliveredTo":["mac","chrome"]},
      {"id":"n5","type":"email","title":"Urgent email","message":"Min-ji Choi: 견적서 수량 재확인 [18c3c]",
       "isRead":false,"sourceEmailId":"x5","createdAt":"2026-07-29T07:30:00Z","lane":"PUSH","group":"reply",
       "reason":{"verified":true,"quote":"“오늘 17시까지 회신 부탁드립니다”","quoteIn":"body"},"deliveredTo":["chrome"]},
      {"id":"n6","type":"reminder","title":"Reminder · Follow up","message":"Board deck — numbers check",
       "isRead":false,"createdAt":"2026-07-29T00:00:00Z",
       "reason":{"text":"Snoozed yesterday until 09:00 today","verified":false},"deliveredTo":["mac"]},
      {"id":"n7","type":"email","title":"Klorn replied for you","message":"Re: Meeting time next week",
       "isRead":true,"createdAt":"2026-07-28T09:00:00Z",
       "reason":{"text":"Sent by an auto-reply rule you created","verified":false}}
    ]}
    """

    static let notificationChannelsJSON = """
    {"webPush":{"state":"live","currentDevice":null},"desktop":[{"app":"mac","running":true,"lastSeenAt":"2026-07-29T08:29:00Z"}],
     "telegram":{"linked":false},"mobile":{"registered":false},"working":true}
    """

    /// The fixture store state on a nav model.
    static func notificationCenterModel() -> AppModel {
        let model = navModel(firewallJSON: navFirewallJSON)
        let rows = (try? JSONDecoder().decode(
            NotificationsResponse.self, from: Data(notificationFixtureJSON.utf8)))?.notifications ?? []
        let channels = try? JSONDecoder().decode(AlertChannelHealth.self, from: Data(notificationChannelsJSON.utf8))
        model.notificationCenter.seedForRender(rows: rows, channels: channels)
        return model
    }

    /// The panel alone in both appearances (tall enough for every row: the
    /// renderer cannot draw a scroll view), and the panel over the shell with
    /// the assistant open, at the window's floor width and at 1280.
    static func renderNotificationCenter(dir: URL, actions: ShellActions) -> Bool {
        var ok = true
        let date = ISO8601DateFormatter().date(from: "2026-07-29T08:30:00Z") ?? Date()
        let panel = { NotificationPanel(actions: actions, now: date) }
        let shell = { MainShell(actions: actions, renderDate: date) }
        for dark in [true, false] {
            let suffix = dark ? "dark" : "light"
            let model = notificationCenterModel()
            ok = writeShot(
                "nc-panel-\(suffix)", size: CGSize(width: 452, height: 1180), align: .top,
                model: model, dir: dir, dark: dark
            ) {
                panel()
                    .frame(width: NotificationPanelGeometry.preferredWidth, height: 1150)
                    .padding(Theme.s4)
            } && ok
            for width: CGFloat in [MainWindowRules.minSize.width, 1280] {
                let windowModel = notificationCenterModel()
                windowModel.navigate(to: .today)
                windowModel.showAssistantPanel = true
                windowModel.notificationCenter.panelOpen = true
                ok = writeShot(
                    "nc-window-\(Int(width))-\(suffix)", size: CGSize(width: width, height: 720), align: .top,
                    model: windowModel, dir: dir, dark: dark, shell) && ok
            }
        }
        return ok
    }
}

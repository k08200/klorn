import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        KlornNotificationCategories.register()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // --- Native push (APNs) ---
    // @capacitor/push-notifications needs these forwarded so the plugin receives
    // the APNs device token (the 'registration' event). Without them iOS push
    // silently never registers. The token is a raw APNs token (not FCM) — the
    // backend delivers to it via APNs directly (packages/api/src/push-apns.ts).
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: deviceToken
        )
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }

}

// --- Notification actions (long-press a Klorn notification) ---
// Decision N1 (2026-11-08). The server picks a category with `aps.category`
// on a mail push (packages/api/src/notify/push-apns.ts buildApnsBody; the
// identifiers are packages/contract/src/push.ts ApnsMailCategory — keep them
// identical), at most 4 actions, in this order:
//   KLORN_PUSH_MAIL_DRAFT — Send draft · Later · Not urgent · Done
//   KLORN_PUSH_MAIL       — Reply · Later · Not urgent · Done
//   KLORN_PUSH_MEETING    — Later (Join needs a verified meeting link; a mail has none)
// The app's JS handles each action id (src/push/route.ts):
//   KLORN_SEND       — "Send draft": requires the device to be unlocked AND
//                      opens the app on the approval card, where sending is
//                      one more explicit tap. Nothing is sent from the lock screen.
//   KLORN_REPLY      — "Reply": opens the app on the mail. Sending stays manual.
//   KLORN_LATER      — "Later": snoozes the mail until later today (no UI).
//   KLORN_NOT_URGENT — "Not urgent": moves the mail to QUEUE (no UI).
//   KLORN_DONE       — "Done": marks the mail done by its email id (no UI).
// There is no Silent action: a misclick there costs too much.
enum KlornNotificationCategories {
    static let pushWithDraft = "KLORN_PUSH_MAIL_DRAFT"
    static let push = "KLORN_PUSH_MAIL"
    static let meeting = "KLORN_PUSH_MEETING"

    static func register() {
        let t = titles()
        let send = UNNotificationAction(
            identifier: "KLORN_SEND",
            title: t.send,
            options: [.authenticationRequired, .foreground]
        )
        let reply = UNNotificationAction(identifier: "KLORN_REPLY", title: t.reply, options: [.foreground])
        let later = UNNotificationAction(identifier: "KLORN_LATER", title: t.later, options: [])
        let notUrgent = UNNotificationAction(identifier: "KLORN_NOT_URGENT", title: t.notUrgent, options: [])
        let done = UNNotificationAction(identifier: "KLORN_DONE", title: t.done, options: [])
        let withDraft = UNNotificationCategory(
            identifier: pushWithDraft,
            actions: [send, later, notUrgent, done],
            intentIdentifiers: [],
            options: []
        )
        let plain = UNNotificationCategory(
            identifier: push,
            actions: [reply, later, notUrgent, done],
            intentIdentifiers: [],
            options: []
        )
        let meetingMail = UNNotificationCategory(
            identifier: meeting,
            actions: [later],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([withDraft, plain, meetingMail])
    }

    /// The action titles in the device's language (the app's 7 languages, English otherwise).
    private static func titles() -> (send: String, reply: String, later: String, notUrgent: String, done: String) {
        let lang = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "en"
        switch lang {
        case "ko": return ("초안 보내기", "답장", "나중에", "급하지 않음", "처리 완료")
        case "ja": return ("下書きを送信", "返信", "あとで", "急ぎではない", "処理済み")
        case "zh": return ("发送草稿", "回复", "稍后", "不紧急", "已处理")
        case "es": return ("Enviar borrador", "Responder", "Más tarde", "No urgente", "Hecho")
        case "fr": return ("Envoyer le brouillon", "Répondre", "Plus tard", "Pas urgent", "Traité")
        case "de": return ("Entwurf senden", "Antworten", "Später", "Nicht dringend", "Erledigt")
        default: return ("Send draft", "Reply", "Later", "Not urgent", "Done")
        }
    }
}

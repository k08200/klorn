package ai.klorn.app.push;

import android.app.ActivityManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import ai.klorn.app.MainActivity;
import ai.klorn.app.R;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Locale;
import java.util.Map;
import org.json.JSONObject;

/**
 * Posts Klorn's data-only FCM messages itself, with action buttons, in every
 * app state — including a killed app, where @capacitor/push-notifications
 * only stores the message for the next launch and nothing is shown.
 *
 * Replaces the plugin's own MessagingService in the manifest (tools:node=
 * "remove" there, this one registered instead) and extends it, so token
 * rotation and every other message reach the plugin exactly as before:
 *
 *   - a message that is not a Klorn data push (a notification message, no
 *     title/body, a stale replay) → super: unchanged plugin behaviour;
 *   - a Klorn data push while the app is on screen → super: the app shows its
 *     in-app banner (src/push/PushLayer.tsx), as on iOS;
 *   - otherwise → posted here, and NOT handed to the plugin, so neither the
 *     WebView (src/platform/local-notify.ts) nor a launch-time replay of
 *     `lastMessage` can post it a second time.
 *
 * Every button opens the app (an activity PendingIntent; a secure lock screen
 * asks to unlock first), and the action runs there — the same snooze /
 * dismiss / approval card as an iOS action. Nothing is ever sent from a
 * notification. The extras use the plugin's own tap contract: an intent with
 * `google.message_id` reaches JS as `pushNotificationActionPerformed`
 * ("tap", data = the extras), on a cold start too (BridgeActivity.load →
 * onNewIntent), and `klornAction` names the button (src/push/route.ts
 * actionFromTap). MainActivity cancels the notification when it receives one.
 */
public class KlornMessagingService extends MessagingService {

    public static final String EXTRA_MESSAGE_ID = "google.message_id";
    public static final String EXTRA_ACTION = "klornAction";
    public static final String EXTRA_NOTIFICATION_ID = "klornNotificationId";

    static final String ACTION_LATER = "KLORN_LATER";
    static final String ACTION_NOT_URGENT = "KLORN_NOT_URGENT";
    static final String ACTION_DONE = "KLORN_DONE";

    /** Written by the app in its language (src/platform/local-notify.ts); Capacitor Preferences' file. */
    private static final String PREFS_GROUP = "CapacitorStorage";
    private static final String LABELS_KEY = "klorn-android-push-labels";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        KlornPushPayload push = KlornPushPayload.parse(
            remoteMessage.getNotification() != null,
            remoteMessage.getData(),
            System.currentTimeMillis()
        );
        if (push == null || appInForeground()) {
            super.onMessageReceived(remoteMessage);
            return;
        }
        try {
            post(push, remoteMessage.getMessageId());
        } catch (RuntimeException e) {
            // Never lose the message to a native failure: the plugin path still
            // shows it when the app's process is alive.
            super.onMessageReceived(remoteMessage);
        }
    }

    private boolean appInForeground() {
        ActivityManager.RunningAppProcessInfo state = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(state);
        return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    }

    private void post(KlornPushPayload push, String messageId) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(this);
        // Notifications off (Android 13+ permission, or the app's switch): post nothing, never prompt.
        if (!manager.areNotificationsEnabled()) return;
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return;
        }
        Labels labels = labels();
        ensureChannels(labels);

        String tapId = messageId != null ? messageId : "klorn:" + push.notificationId;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, push.channelId)
            .setSmallIcon(R.drawable.ic_stat_klorn)
            .setContentTitle(push.title)
            .setContentText(push.body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(push.body))
            .setAutoCancel(true)
            .setGroup("klorn")
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            // VISIBILITY_PRIVATE: the lock screen follows the user's "sensitive content" setting.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPriority(
                KlornPushPayload.CHANNEL_PUSH.equals(push.channelId)
                    ? NotificationCompat.PRIORITY_HIGH
                    : NotificationCompat.PRIORITY_DEFAULT
            )
            .setContentIntent(intentFor(push, tapId, null, 0));

        if (push.category != null) {
            // Same order as src/push/android.ts androidActionTypes (decision N1):
            // Later · Not urgent · Done; a MEETING mail gets Later only.
            builder.addAction(0, labels.later, intentFor(push, tapId, ACTION_LATER, 1));
            if (!KlornPushPayload.CATEGORY_MEETING.equals(push.category)) {
                builder.addAction(0, labels.notUrgent, intentFor(push, tapId, ACTION_NOT_URGENT, 2));
                builder.addAction(0, labels.done, intentFor(push, tapId, ACTION_DONE, 3));
            }
        }
        try {
            manager.notify(push.notificationId, builder.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS revoked between the check and the post.
        }
    }

    private PendingIntent intentFor(KlornPushPayload push, String tapId, String action, int slot) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(action != null ? action : Intent.ACTION_VIEW);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(EXTRA_MESSAGE_ID, tapId);
        intent.putExtra(EXTRA_NOTIFICATION_ID, String.valueOf(push.notificationId));
        if (action != null) intent.putExtra(EXTRA_ACTION, action);
        for (Map.Entry<String, String> entry : push.data.entrySet()) {
            intent.putExtra(entry.getKey(), entry.getValue());
        }
        // One request code per (notification, button), so the four intents never overwrite each other.
        int requestCode = push.notificationId * 4 + slot;
        return PendingIntent.getActivity(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /**
     * The channels the app creates at launch (src/platform/local-notify.ts).
     * Notification permission is only ever granted from inside the app, so
     * they normally exist already; this only covers a cleared-data edge.
     * Creating an existing channel never changes the importance the user chose.
     */
    private void ensureChannels(Labels labels) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(KlornPushPayload.CHANNEL_PUSH) == null) {
            NotificationChannel push = new NotificationChannel(
                KlornPushPayload.CHANNEL_PUSH,
                labels.pushChannel,
                NotificationManager.IMPORTANCE_HIGH
            );
            push.enableVibration(true);
            nm.createNotificationChannel(push);
        }
        if (nm.getNotificationChannel(KlornPushPayload.CHANNEL_OTHER) == null) {
            nm.createNotificationChannel(
                new NotificationChannel(
                    KlornPushPayload.CHANNEL_OTHER,
                    labels.otherChannel,
                    NotificationManager.IMPORTANCE_DEFAULT
                )
            );
        }
    }

    static final class Labels {

        final String later;
        final String notUrgent;
        final String done;
        final String pushChannel;
        final String otherChannel;

        Labels(String later, String notUrgent, String done, String pushChannel, String otherChannel) {
            this.later = later;
            this.notUrgent = notUrgent;
            this.done = done;
            this.pushChannel = pushChannel;
            this.otherChannel = otherChannel;
        }
    }

    /** The app language's labels when the app saved them, else the device language's. */
    private Labels labels() {
        Labels fallback = deviceLanguageLabels();
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_GROUP, Context.MODE_PRIVATE);
            String json = prefs.getString(LABELS_KEY, null);
            if (json == null) return fallback;
            JSONObject o = new JSONObject(json);
            return new Labels(
                o.optString("later", fallback.later),
                o.optString("notUrgent", fallback.notUrgent),
                o.optString("done", fallback.done),
                o.optString("pushChannel", fallback.pushChannel),
                o.optString("otherChannel", fallback.otherChannel)
            );
        } catch (Exception e) {
            return fallback;
        }
    }

    private static Labels deviceLanguageLabels() {
        String lang = Locale.getDefault().getLanguage();
        switch (lang) {
            case "ko":
                return new Labels("나중에", "급하지 않음", "처리 완료", "PUSH 메일", "기타 알림");
            case "ja":
                return new Labels("あとで", "急ぎではない", "処理済み", "PUSH メール", "その他の通知");
            case "zh":
                return new Labels("稍后", "不紧急", "已处理", "PUSH 邮件", "其他通知");
            case "es":
                return new Labels("Más tarde", "No urgente", "Hecho", "Correo PUSH", "Otras notificaciones");
            case "fr":
                return new Labels("Plus tard", "Pas urgent", "Traité", "E-mails PUSH", "Autres notifications");
            case "de":
                return new Labels("Später", "Nicht dringend", "Erledigt", "PUSH-Mails", "Weitere Benachrichtigungen");
            default:
                return new Labels("Later", "Not urgent", "Done", "PUSH mail", "Other notifications");
        }
    }
}

package ai.klorn.app.push;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * A data-only Klorn FCM message, validated — the native twin of
 * src/push/android.ts parseDataPush. Pure Java (no Android types) so the
 * rules are unit-tested off-device (src/test/.../KlornPushPayloadTest.java)
 * and stay identical to the JS ones the in-app path uses:
 *
 *   - a message with a `notification` block is not ours (the OS showed it);
 *   - `title` and `body` are required, trimmed, capped at 120 / 600 chars;
 *   - `sentAt` older than 15 minutes is a replay, dropped;
 *   - ids must match [A-Za-z0-9_-]{1,128}; anything else is ignored;
 *   - the action set follows the ids (a pendingActionId → the draft set, an
 *     emailId / attentionItemId → the plain set, else no buttons), never the
 *     server's `category`, which is the NotifCategory;
 *   - `category: "email_urgent"` (a PUSH-lane mail) rings on klorn_push;
 *   - the notification id is the same 31-bit FNV-1a hash, so a repeat about
 *     the same mail replaces the notification instead of stacking.
 */
public final class KlornPushPayload {

    public static final String CHANNEL_PUSH = "klorn_push";
    public static final String CHANNEL_OTHER = "klorn_other";
    public static final String CATEGORY_DRAFT = "KLORN_PUSH_MAIL_DRAFT";
    public static final String CATEGORY_PLAIN = "KLORN_PUSH_MAIL";
    public static final long STALE_AFTER_MS = 15L * 60_000L;

    private static final String URGENT_MAIL_CATEGORY = "email_urgent";
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_-]{1,128}$");
    private static final int TITLE_MAX = 120;
    private static final int BODY_MAX = 600;

    public final int notificationId;
    public final String title;
    public final String body;
    /** CATEGORY_DRAFT, CATEGORY_PLAIN, or null (no buttons; a tap still routes). */
    public final String category;
    public final String channelId;
    /** Only the validated fields, handed back to the app on tap (src/push/route.ts reads them). */
    public final Map<String, String> data;

    private KlornPushPayload(
        int notificationId,
        String title,
        String body,
        String category,
        String channelId,
        Map<String, String> data
    ) {
        this.notificationId = notificationId;
        this.title = title;
        this.body = body;
        this.category = category;
        this.channelId = channelId;
        this.data = data;
    }

    /** The notification to post, or null when the message is not a showable Klorn data push. */
    public static KlornPushPayload parse(boolean hasNotificationBlock, Map<String, String> raw, long now) {
        if (hasNotificationBlock || raw == null) return null;
        String title = text(raw.get("title"), TITLE_MAX);
        String body = text(raw.get("body"), BODY_MAX);
        if (title == null || body == null) return null;

        String sentAtRaw = raw.get("sentAt");
        if (sentAtRaw != null) {
            try {
                double sentAt = Double.parseDouble(sentAtRaw.trim());
                if (!Double.isNaN(sentAt) && !Double.isInfinite(sentAt) && now - sentAt > STALE_AFTER_MS) {
                    return null;
                }
            } catch (NumberFormatException ignored) {
                // Not a number: like JS Number("x") → NaN, which never counts as stale.
            }
        }

        String emailId = id(raw.get("emailId"));
        String attentionItemId = id(raw.get("attentionItemId"));
        String pendingActionId = id(raw.get("pendingActionId"));
        String category = pendingActionId != null
            ? CATEGORY_DRAFT
            : (emailId != null || attentionItemId != null) ? CATEGORY_PLAIN : null;
        boolean isPush = URGENT_MAIL_CATEGORY.equals(raw.get("category"));

        Map<String, String> kept = new LinkedHashMap<>();
        if (emailId != null) kept.put("emailId", emailId);
        if (attentionItemId != null) kept.put("attentionItemId", attentionItemId);
        if (pendingActionId != null) kept.put("pendingActionId", pendingActionId);
        if (raw.get("route") != null) kept.put("route", raw.get("route"));
        if (raw.get("url") != null) kept.put("url", raw.get("url"));

        String key = attentionItemId != null
            ? attentionItemId
            : emailId != null ? emailId : pendingActionId != null ? pendingActionId : title + "\n" + body;
        return new KlornPushPayload(
            notificationIdOf(key),
            title,
            body,
            category,
            isPush ? CHANNEL_PUSH : CHANNEL_OTHER,
            kept
        );
    }

    /** 31-bit positive FNV-1a over UTF-16 code units — the same value as android.ts notificationIdOf. */
    public static int notificationIdOf(String key) {
        int hash = 0x811c9dc5;
        for (int i = 0; i < key.length(); i++) {
            hash ^= key.charAt(i);
            hash *= 0x01000193;
        }
        int id = hash >>> 1;
        return id == 0 ? 1 : id;
    }

    private static String text(String value, int max) {
        if (value == null) return null;
        String trimmed = value.trim();
        if (trimmed.isEmpty()) return null;
        return trimmed.length() > max ? trimmed.substring(0, max - 1) + "…" : trimmed;
    }

    private static String id(String value) {
        return value != null && ID.matcher(value).matches() ? value : null;
    }
}

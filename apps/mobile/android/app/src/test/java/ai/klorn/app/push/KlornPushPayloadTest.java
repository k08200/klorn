package ai.klorn.app.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

/** The native twin of src/push/android.test.ts — the same rules and the same vectors. */
public class KlornPushPayloadTest {

    private static final long NOW = 1_800_000_000_000L;

    private static Map<String, String> mail() {
        Map<String, String> data = new HashMap<>();
        data.put("title", "Klorn — Alice");
        data.put("body", "Q3 budget");
        data.put("category", "email_urgent");
        data.put("url", "/inbox/firewall");
        data.put("emailId", "email-1");
        data.put("route", "/mail/email-1");
        data.put("sentAt", String.valueOf(NOW - 1000));
        return data;
    }

    @Test
    public void notificationIdsMatchTheJsHash() {
        assertEquals(1470695920, KlornPushPayload.notificationIdOf("item-1"));
        assertEquals(1646888158, KlornPushPayload.notificationIdOf("email-1"));
        assertEquals(1482157022, KlornPushPayload.notificationIdOf("pa-1"));
        assertEquals(384908386, KlornPushPayload.notificationIdOf("Klorn — Alice\nQ3 budget"));
        assertEquals(1992001445, KlornPushPayload.notificationIdOf("처리 완료"));
    }

    @Test
    public void aMailPushGetsThePlainSetOnThePushChannel() {
        KlornPushPayload p = KlornPushPayload.parse(false, mail(), NOW);
        assertNotNull(p);
        assertEquals("Klorn — Alice", p.title);
        assertEquals("Q3 budget", p.body);
        assertEquals(KlornPushPayload.CATEGORY_PLAIN, p.category);
        assertEquals(KlornPushPayload.CHANNEL_PUSH, p.channelId);
        assertEquals(KlornPushPayload.notificationIdOf("email-1"), p.notificationId);
        assertEquals("email-1", p.data.get("emailId"));
        assertEquals("/mail/email-1", p.data.get("route"));
        assertEquals("/inbox/firewall", p.data.get("url"));
        // Only validated fields go back to the app.
        assertNull(p.data.get("title"));
        assertNull(p.data.get("category"));
    }

    @Test
    public void anApprovalGetsTheDraftSetAndOtherCategoriesTheOtherChannel() {
        Map<String, String> data = mail();
        data.put("pendingActionId", "pa-1");
        data.put("category", "agent_proposal");
        KlornPushPayload p = KlornPushPayload.parse(false, data, NOW);
        assertNotNull(p);
        assertEquals(KlornPushPayload.CATEGORY_DRAFT, p.category);
        assertEquals(KlornPushPayload.CHANNEL_OTHER, p.channelId);
        assertEquals("pa-1", p.data.get("pendingActionId"));
    }

    @Test
    public void theAttentionItemKeysTheNotificationWhenPresent() {
        Map<String, String> data = mail();
        data.put("attentionItemId", "item-1");
        KlornPushPayload p = KlornPushPayload.parse(false, data, NOW);
        assertNotNull(p);
        assertEquals(1470695920, p.notificationId);
    }

    @Test
    public void notOursOrNotShowable() {
        // A notification message: the OS already showed it.
        assertNull(KlornPushPayload.parse(true, mail(), NOW));
        Map<String, String> noTitle = mail();
        noTitle.remove("title");
        assertNull(KlornPushPayload.parse(false, noTitle, NOW));
        Map<String, String> blankBody = mail();
        blankBody.put("body", "   ");
        assertNull(KlornPushPayload.parse(false, blankBody, NOW));
        assertNull(KlornPushPayload.parse(false, null, NOW));
    }

    @Test
    public void aStaleReplayIsDroppedAndAnUnparseableSentAtIsNot() {
        Map<String, String> stale = mail();
        stale.put("sentAt", String.valueOf(NOW - KlornPushPayload.STALE_AFTER_MS - 1));
        assertNull(KlornPushPayload.parse(false, stale, NOW));
        Map<String, String> junk = mail();
        junk.put("sentAt", "soon");
        assertNotNull(KlornPushPayload.parse(false, junk, NOW));
        Map<String, String> none = mail();
        none.remove("sentAt");
        assertNotNull(KlornPushPayload.parse(false, none, NOW));
    }

    @Test
    public void malformedIdsAreIgnoredAndWithoutIdsThereAreNoButtons() {
        Map<String, String> data = mail();
        data.put("emailId", "../../etc");
        data.put("pendingActionId", "x".repeat(129));
        KlornPushPayload p = KlornPushPayload.parse(false, data, NOW);
        assertNotNull(p);
        assertNull(p.category);
        assertTrue(!p.data.containsKey("emailId") && !p.data.containsKey("pendingActionId"));
        assertEquals(KlornPushPayload.notificationIdOf("Klorn — Alice\nQ3 budget"), p.notificationId);
    }

    @Test
    public void longTextIsCappedWithAnEllipsis() {
        Map<String, String> data = mail();
        data.put("title", "t".repeat(200));
        data.put("body", "b".repeat(700));
        KlornPushPayload p = KlornPushPayload.parse(false, data, NOW);
        assertNotNull(p);
        assertEquals(120, p.title.length());
        assertTrue(p.title.endsWith("…"));
        assertEquals(600, p.body.length());
    }
}

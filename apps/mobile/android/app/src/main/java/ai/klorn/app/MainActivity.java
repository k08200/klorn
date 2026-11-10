package ai.klorn.app;

import android.content.Intent;
import androidx.core.app.NotificationManagerCompat;
import ai.klorn.app.push.KlornMessagingService;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Also runs for the launch intent (BridgeActivity.load → onNewIntent). An
     * intent from a notification Klorn posted itself (push/KlornMessagingService)
     * clears that notification — an action button does not auto-cancel the way a
     * tap does — before the plugins hand the tap and its action to the app.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        if (intent != null) {
            String id = intent.getStringExtra(KlornMessagingService.EXTRA_NOTIFICATION_ID);
            if (id != null) {
                try {
                    NotificationManagerCompat.from(this).cancel(Integer.parseInt(id));
                } catch (NumberFormatException ignored) {
                    // Not one of ours.
                }
            }
        }
        super.onNewIntent(intent);
    }
}

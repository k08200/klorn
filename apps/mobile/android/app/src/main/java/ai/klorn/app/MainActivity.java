package ai.klorn.app;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.core.app.NotificationManagerCompat;
import ai.klorn.app.push.KlornMessagingService;
import ai.klorn.app.shell.ShellWebViewClient;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Route bundle requests the way Cloudflare routes app.klorn.ai
     * (shell/ShellWebViewClient). Set right after the bridge exists, before the
     * first page load reaches the local server; service-worker fetches get the
     * same routing, as Capacitor wires them to its local server too.
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ShellWebViewClient client = new ShellWebViewClient(bridge);
        bridge.setWebViewClient(client);
        if (bridge.getConfig().isResolveServiceWorkerRequests()) {
            ServiceWorkerController.getInstance().setServiceWorkerClient(
                new ServiceWorkerClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                        return bridge.getLocalServer().shouldInterceptRequest(client.routed(request));
                    }
                }
            );
        }
    }

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

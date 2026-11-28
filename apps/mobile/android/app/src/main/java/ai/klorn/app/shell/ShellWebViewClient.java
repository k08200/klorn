package ai.klorn.app.shell;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Serves the bundle the way Cloudflare serves app.klorn.ai: before Capacitor's
 * local server sees a request for the app's own origin, its path is rewritten
 * with ShellRouteResolver (so /settings gets settings.html, /email/&lt;id&gt; the
 * email/_.html shell, and the address bar keeps the real path). Capacitor's
 * html5mode would otherwise answer every extension-less path with index.html.
 * The single-page bundle (no shell-routes.json) resolves exactly as before.
 */
public class ShellWebViewClient extends BridgeWebViewClient {

    /** Where `cap sync` copies the web bundle inside the APK's assets. */
    private static final String ASSET_ROOT = "public";
    private static final String ROUTES_FILE = "/shell-routes.json";

    private final Bridge bridge;
    private final AssetManager assets;
    private final ShellRouteResolver.Rules rules;
    private final Map<String, Boolean> existsCache = new ConcurrentHashMap<>();

    public ShellWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
        this.assets = bridge.getContext().getAssets();
        this.rules = ShellRouteResolver.parse(readAsset(ROUTES_FILE));
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        return super.shouldInterceptRequest(view, routed(request));
    }

    /** The request with its path resolved, or the request itself when it is not for the bundle. */
    public WebResourceRequest routed(WebResourceRequest request) {
        Uri url = request.getUrl();
        Uri app = Uri.parse(bridge.getLocalUrl());
        if (url == null || !app.getScheme().equals(url.getScheme()) || !app.getHost().equals(url.getHost())) {
            return request;
        }
        String path = url.getPath() == null ? "/" : url.getPath();
        String resolved = ShellRouteResolver.resolve(path, rules, this::assetExists);
        if (resolved.equals(path)) return request;
        return new RoutedRequest(request, url.buildUpon().path(resolved).build());
    }

    private boolean assetExists(String path) {
        return existsCache.computeIfAbsent(path, (p) -> {
            try (InputStream ignored = assets.open(ASSET_ROOT + p)) {
                return true;
            } catch (IOException e) {
                return false;
            }
        });
    }

    private String readAsset(String path) {
        try (InputStream in = assets.open(ASSET_ROOT + path)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n; (n = in.read(buffer)) != -1; ) out.write(buffer, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            // The single-page bundle ships no table: Capacitor's default behaviour.
            return null;
        }
    }

    /** A request that differs from the original only in its URL. */
    private static final class RoutedRequest implements WebResourceRequest {

        private final WebResourceRequest original;
        private final Uri url;

        RoutedRequest(WebResourceRequest original, Uri url) {
            this.original = original;
            this.url = url;
        }

        @Override
        public Uri getUrl() {
            return url;
        }

        @Override
        public boolean isForMainFrame() {
            return original.isForMainFrame();
        }

        @Override
        public boolean isRedirect() {
            return original.isRedirect();
        }

        @Override
        public boolean hasGesture() {
            return original.hasGesture();
        }

        @Override
        public String getMethod() {
            return original.getMethod();
        }

        @Override
        public Map<String, String> getRequestHeaders() {
            return original.getRequestHeaders();
        }
    }
}

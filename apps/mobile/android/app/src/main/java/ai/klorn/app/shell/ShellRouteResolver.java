package ai.klorn.app.shell;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Which bundled file the shell serves for a request path — the Java port of
 * apps/mobile/shell/resolve-route.mjs (the reference, with the reasons). Both
 * must give the answers in apps/mobile/shell/route-cases.json.
 *
 * Capacitor answers every extension-less path with index.html; the
 * packages/web static export needs /settings → settings.html and
 * /email/&lt;id&gt; → email/_.html (its prerendered shell), as Cloudflare's
 * _redirects does on the web.
 */
public final class ShellRouteResolver {

    /** Whether the bundle holds a file at this site path ("/email/_.html"). */
    public interface FileExists {
        boolean at(String path);
    }

    public static final class Redirect {

        final String from;
        final String to;

        Redirect(String from, String to) {
            this.from = from;
            this.to = to;
        }
    }

    public static final class Shell {

        final String prefix;
        final String target;

        Shell(String prefix, String target) {
            this.prefix = prefix;
            this.target = target;
        }
    }

    public static final class Rules {

        public static final Rules EMPTY = new Rules(Collections.emptyList(), Collections.emptyList());

        final List<Redirect> redirects;
        final List<Shell> shells;

        Rules(List<Redirect> redirects, List<Shell> shells) {
            this.redirects = redirects;
            this.shells = shells;
        }
    }

    private ShellRouteResolver() {}

    private static boolean isPlainPath(String value) {
        return value != null && value.startsWith("/") && !value.startsWith("//");
    }

    /** shell-routes.json text → rules; malformed entries are dropped, null or bad JSON is EMPTY. */
    public static Rules parse(String text) {
        if (text == null) return Rules.EMPTY;
        try {
            JSONObject raw = new JSONObject(text);
            List<Redirect> redirects = new ArrayList<>();
            JSONArray r = raw.optJSONArray("redirects");
            for (int i = 0; r != null && i < r.length(); i++) {
                JSONObject entry = r.optJSONObject(i);
                if (entry == null) continue;
                String from = entry.optString("from", null);
                String to = entry.optString("to", null);
                if (isPlainPath(from) && isPlainPath(to)) redirects.add(new Redirect(from, to));
            }
            List<Shell> shells = new ArrayList<>();
            JSONArray s = raw.optJSONArray("shells");
            for (int i = 0; s != null && i < s.length(); i++) {
                JSONObject entry = s.optJSONObject(i);
                if (entry == null) continue;
                String prefix = entry.optString("prefix", null);
                String target = entry.optString("target", null);
                if (isPlainPath(prefix) && prefix.endsWith("/") && isPlainPath(target)) {
                    shells.add(new Shell(prefix, target));
                }
            }
            return new Rules(redirects, shells);
        } catch (JSONException e) {
            return Rules.EMPTY;
        }
    }

    private static String redirectOf(String path, Rules rules) {
        for (Redirect r : rules.redirects) {
            if (r.from.equals(path)) return r.to;
        }
        return null;
    }

    private static String shellOf(String path, Rules rules) {
        for (Shell shell : rules.shells) {
            if (!path.startsWith(shell.prefix)) continue;
            String rest = path.substring(shell.prefix.length());
            if (!rest.isEmpty() && !rest.contains("/")) return shell.target;
        }
        return null;
    }

    public static String resolve(String rawPath, Rules rules, FileExists exists) {
        String path = rawPath == null || rawPath.isEmpty() ? "/" : rawPath;
        while (path.length() > 1 && path.endsWith("/")) path = path.substring(0, path.length() - 1);
        if (path.equals("/")) return "/index.html";

        String last = path.substring(path.lastIndexOf('/') + 1);
        if (last.contains(".")) {
            if (exists.at(path) || !path.endsWith(".txt")) return path;
            String base = path.substring(0, path.length() - ".txt".length());
            String mapped = redirectOf(base, rules);
            if (mapped == null) mapped = shellOf(base, rules);
            return mapped != null && exists.at(mapped + ".txt") ? mapped + ".txt" : path;
        }

        String redirected = redirectOf(path, rules);
        String page = redirected != null ? redirected : path;
        if (exists.at(page + ".html")) return page + ".html";
        if (exists.at(page + "/index.html")) return page + "/index.html";
        String shell = shellOf(page, rules);
        if (shell != null && exists.at(shell + ".html")) return shell + ".html";
        return exists.at("/404.html") ? "/404.html" : "/index.html";
    }
}

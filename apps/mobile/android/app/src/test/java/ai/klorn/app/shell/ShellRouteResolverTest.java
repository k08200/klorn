package ai.klorn.app.shell;

import static org.junit.Assert.assertEquals;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** The native twin of apps/mobile/shell/resolve-route.test.mjs — the same vectors file. */
public class ShellRouteResolverTest {

    private static JSONObject vectors() throws Exception {
        // Gradle runs unit tests from the module directory (apps/mobile/android/app).
        File file = new File("../../shell/route-cases.json");
        return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }

    private static ShellRouteResolver.FileExists existsIn(JSONArray files) {
        Set<String> set = new HashSet<>();
        for (int i = 0; i < files.length(); i++) set.add(files.getString(i));
        return set::contains;
    }

    private static void assertCases(JSONArray cases, ShellRouteResolver.Rules rules, ShellRouteResolver.FileExists exists) {
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            String path = c.getString("path");
            assertEquals("path \"" + path + "\"", c.getString("expect"), ShellRouteResolver.resolve(path, rules, exists));
        }
    }

    @Test
    public void nextExportPathsMapToTheFilesCloudflareServes() throws Exception {
        JSONObject v = vectors();
        ShellRouteResolver.Rules rules = ShellRouteResolver.parse(v.getJSONObject("rules").toString());
        assertCases(v.getJSONArray("cases"), rules, existsIn(v.getJSONArray("files")));
    }

    @Test
    public void singlePageBundleStillGetsIndexHtml() throws Exception {
        JSONObject spa = vectors().getJSONObject("spaCases");
        assertCases(spa.getJSONArray("cases"), ShellRouteResolver.parse(null), existsIn(spa.getJSONArray("files")));
    }

    @Test
    public void malformedRulesAreDropped() {
        ShellRouteResolver.Rules rules = ShellRouteResolver.parse(
            "{\"redirects\":[{\"from\":\"a\",\"to\":\"/b\"}],\"shells\":[{\"prefix\":\"/y\",\"target\":\"/y/_\"}]}"
        );
        assertEquals(0, rules.redirects.size());
        assertEquals(0, rules.shells.size());
        assertEquals(0, ShellRouteResolver.parse("not json").shells.size());
    }
}

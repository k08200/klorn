//! The one IPC command the remote page may call to post an OS banner, and
//! what a click on that banner does.
//!
//! The notification plugin's own `notify` command accepts the whole
//! NotificationData (icon path, attachments, schedule, sound, ...). On Windows
//! an icon becomes a `file:///` image source, so a compromised page could
//! point it at a UNC path. Instead the remote capability grants only this
//! command: title and body as plain text, length-clamped here, plus the
//! in-app page a click opens — only Today or one mail (`open_path`);
//! everything else is fixed by the shell.
//!
//! A click (decision N1): bring the window back and open that page inside it.
//! The plugin reports a click only while the toast is on screen, not once it
//! moved to the Action Center (tauri-plugin-notification 2.7 desktop.rs). For
//! that reason the toast has no Reply / Later buttons: from the Action Center
//! they would silently do nothing.

use tauri::plugin::PermissionState;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};

use crate::tray;

pub const TITLE_MAX: usize = 120;
pub const BODY_MAX: usize = 240;
const FALLBACK_TITLE: &str = "Klorn";
/// Key of the toast's extra payload that holds the page a click opens.
const OPEN_KEY: &str = "open";
/// The action id the plugin reports for a click on the toast itself.
const TAP: &str = "tap";
const TODAY_PATH: &str = "/today";
const MAIL_PREFIX: &str = "/email/";
const MAIL_ID_MAX: usize = 64;

/// Plain text, control characters removed, clamped to `max` characters
/// (not bytes, so Korean text is never cut mid-codepoint). Pure.
pub fn clean(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Like `clean`, but keeps one line break: an N1 body is the subject, then the
/// judge's reason on a second line. Further lines join the second. Pure.
pub fn clean_body(text: &str, max: usize) -> String {
    let mut lines = text
        .split('\n')
        .map(|line| clean(line, max))
        .filter(|line| !line.is_empty());
    let first = lines.next().unwrap_or_default();
    let rest: Vec<String> = lines.collect();
    let joined = if rest.is_empty() {
        first
    } else {
        format!("{first}\n{}", rest.join(" "))
    };
    joined
        .chars()
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// The banner text the shell will actually post. Pure.
pub fn sanitize(title: &str, body: &str) -> (String, String) {
    let title = clean(title, TITLE_MAX);
    let title = if title.is_empty() {
        FALLBACK_TITLE.to_string()
    } else {
        title
    };
    (title, clean_body(body, BODY_MAX))
}

/// The page a click may open: Today, or one mail by id (uuid / cuid
/// characters only). Anything else opens nothing. Pure.
pub fn open_path(raw: Option<&str>) -> Option<String> {
    let path = raw?;
    if path == TODAY_PATH {
        return Some(path.to_string());
    }
    let id = path.strip_prefix(MAIL_PREFIX)?;
    let valid = (1..=MAIL_ID_MAX).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    valid.then(|| path.to_string())
}

/// The page to open for a reported action: only a click on the toast itself
/// with a valid page. Pure.
pub fn tap_route(action_id: &str, open: Option<&str>) -> Option<String> {
    if action_id != TAP {
        return None;
    }
    open_path(open)
}

/// Script that opens `path` in the running web app: the app's client-side
/// router when it registered one (components/desktop-toast-router.tsx), else a
/// plain navigation. `path` must come from `open_path` (no quotes possible).
pub fn open_script(path: &str) -> String {
    format!(
        "window.__klornOpenToast ? window.__klornOpenToast('{path}') : window.location.assign('{path}');"
    )
}

/// Handler for every action the plugin reports (registered in main.rs).
pub fn on_action<R: Runtime>(app: &AppHandle<R>, performed: &ActionPerformed) {
    if performed.action_id() != TAP {
        return;
    }
    tray::show_main(app);
    let open = performed
        .notification()
        .and_then(|n| n.extra().get(OPEN_KEY))
        .and_then(|v| v.as_str());
    if let Some(path) = tap_route(performed.action_id(), open) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.eval(open_script(&path));
        }
    }
}

#[tauri::command]
pub fn show_banner<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
    open: Option<String>,
) -> Result<(), String> {
    let notifier = app.notification();
    // Desktop reports Granted; ask anyway so a future platform that prompts
    // still asks on first need, never before.
    let state = notifier.permission_state().map_err(|e| e.to_string())?;
    let state = match state {
        PermissionState::Granted => state,
        _ => notifier.request_permission().map_err(|e| e.to_string())?,
    };
    if state != PermissionState::Granted {
        return Ok(());
    }
    let (title, body) = sanitize(&title, &body);
    let mut builder = notifier.builder().title(title).body(body);
    if let Some(path) = open_path(open.as_deref()) {
        builder = builder.extra(OPEN_KEY, path);
    }
    builder.show().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_by_characters_not_bytes() {
        let (title, body) = sanitize(&"가".repeat(TITLE_MAX + 10), &"b".repeat(BODY_MAX + 10));
        assert_eq!(title.chars().count(), TITLE_MAX);
        assert_eq!(body.chars().count(), BODY_MAX);
    }

    #[test]
    fn strips_control_characters() {
        assert_eq!(sanitize("Kim\u{0}\n\u{1b}", "a\r\nb").0, "Kim");
        assert_eq!(sanitize("x", "a\u{1b}b").1, "ab");
    }

    #[test]
    fn body_keeps_one_line_break_for_the_reason() {
        assert_eq!(
            sanitize("x", "Subject\r\nWhy it matters").1,
            "Subject\nWhy it matters"
        );
        assert_eq!(sanitize("x", "a\nb\nc").1, "a\nb c");
        assert_eq!(sanitize("x", "\n\nonly").1, "only");
    }

    #[test]
    fn opens_only_today_or_one_mail() {
        assert_eq!(open_path(Some("/today")), Some("/today".into()));
        assert_eq!(
            open_path(Some("/email/cm3abc_9-Z")),
            Some("/email/cm3abc_9-Z".into())
        );
        for bad in [
            "/email/",
            "/email/a/b",
            "/email/a?focus=reply",
            "/email/a'b",
            "/email/%2e%2e",
            "https://evil.example/email/a",
            "//evil.example",
            "/settings",
            "/today/x",
            "javascript:alert(1)",
        ] {
            assert_eq!(open_path(Some(bad)), None, "{bad}");
        }
        assert_eq!(open_path(Some(&format!("/email/{}", "a".repeat(65)))), None);
        assert_eq!(open_path(None), None);
    }

    #[test]
    fn only_a_click_on_the_toast_routes() {
        assert_eq!(
            tap_route("tap", Some("/email/x1")),
            Some("/email/x1".into())
        );
        assert_eq!(tap_route("reply", Some("/email/x1")), None);
        assert_eq!(tap_route("tap", None), None);
    }

    #[test]
    fn the_open_script_prefers_the_app_router() {
        assert_eq!(
            open_script("/email/x1"),
            "window.__klornOpenToast ? window.__klornOpenToast('/email/x1') : window.location.assign('/email/x1');"
        );
    }

    #[test]
    fn blank_title_falls_back_to_klorn() {
        assert_eq!(sanitize("  \n", "body").0, "Klorn");
    }
}

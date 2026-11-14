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
//! On Windows the shell posts the toast itself, with a `klorn://toast?…`
//! launch URI and protocol activation, so a click reaches the app from the
//! Action Center too, and starts Klorn when it was quit (toast_link.rs). The
//! notification plugin only reports a click while the toast is on screen; it
//! still posts the toast elsewhere (dev builds) and if the shell's own post
//! fails. The toast has no Reply / Later buttons: a protocol launch carries
//! one URI, not a button choice.
//!
//! Receipts (POST /api/notifications/desktop/receipts): the page passes the
//! bell row id as `receipt`; `show_banner` answers whether it posted the toast
//! (the page then reports `shown`), and a click hands the id back to the page
//! (`click_script`), which reports `clicked`. The shell itself sends nothing:
//! the session lives in the page.

use std::path::{Component, Path};

use tauri::plugin::PermissionState;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};

use crate::toast_link::{self, ToastClick};

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
/// Key of the toast's extra payload that holds the bell row id a click reports.
const RECEIPT_KEY: &str = "receipt";
/// A bell row id: a uuid, the receipts endpoint's own `^[0-9a-fA-F-]{36}$`.
const RECEIPT_ID_LEN: usize = 36;

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

/// The bell row id a receipt names: exactly the endpoint's id shape, so it
/// can never break out of the script it is spliced into. Pure.
pub fn receipt_id(raw: Option<&str>) -> Option<String> {
    let id = raw?;
    let valid =
        id.len() == RECEIPT_ID_LEN && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    valid.then(|| id.to_string())
}

/// The receipt to report for a reported action: only a click on the toast
/// itself, with a valid id. Pure.
pub fn tap_receipt(action_id: &str, receipt: Option<&str>) -> Option<String> {
    if action_id != TAP {
        return None;
    }
    receipt_id(receipt)
}

/// Script that hands a click's receipt to the web app
/// (lib/native/desktop-receipts.ts installToastClickHandler); a no-op while it
/// is not installed. `id` must come from `receipt_id` (no quotes possible).
pub fn click_script(id: &str) -> String {
    format!("window.__klornToastClicked && window.__klornToastClicked('{id}');")
}

/// Script that opens `path` in the running web app: the app's client-side
/// router when it registered one (components/desktop-toast-router.tsx), else a
/// plain navigation. `path` must come from `open_path` (no quotes possible).
pub fn open_script(path: &str) -> String {
    format!(
        "window.__klornOpenToast ? window.__klornOpenToast('{path}') : window.location.assign('{path}');"
    )
}

/// Handler for every action the plugin reports (registered in main.rs): a
/// click on a toast the plugin posted, while it is on screen.
pub fn on_action<R: Runtime>(app: &AppHandle<R>, performed: &ActionPerformed) {
    if performed.action_id() != TAP {
        return;
    }
    let extra = |key: &str| {
        performed
            .notification()
            .and_then(|n| n.extra().get(key))
            .and_then(|v| v.as_str())
    };
    let click = ToastClick {
        open: tap_route(performed.action_id(), extra(OPEN_KEY)),
        receipt: tap_receipt(performed.action_id(), extra(RECEIPT_KEY)),
    };
    toast_link::deliver(app, &click);
}

/// Text for an XML element or attribute value. Pure.
#[cfg_attr(not(windows), allow(dead_code))]
fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// The toast the shell posts on Windows: the title, then each body line, as
/// plain text, and a click that launches `launch` by protocol activation
/// (toast_link.rs). Inputs come from `sanitize` (no control characters but
/// the body's one line break) and `toast_link::launch_uri`. Pure.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn toast_xml(title: &str, body: &str, launch: &str) -> String {
    let texts: String = std::iter::once(title)
        .chain(body.lines().filter(|line| !line.is_empty()))
        .map(|text| format!("<text>{}</text>", xml_escape(text)))
        .collect();
    format!(
        "<toast activationType=\"protocol\" launch=\"{}\"><visual><binding template=\"ToastGeneric\">{texts}</binding></visual></toast>",
        xml_escape(launch)
    )
}

/// PowerShell's AppUserModelID: what the notification plugin posts under when
/// Klorn runs from a cargo build, which has no Start-menu shortcut of its own.
#[cfg_attr(not(windows), allow(dead_code))]
pub const POWERSHELL_APP_ID: &str =
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/// The AppUserModelID the shell's toasts post under — the plugin's rule
/// (tauri-plugin-notification 2.7 desktop.rs): the bundle identifier, which
/// the installer stamps on the Start-menu shortcut, unless the exe runs from
/// `target/debug` or `target/release`. Pure.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn toast_app_id(exe_dir: &Path, identifier: &str) -> String {
    let mut tail = exe_dir.components().rev().filter_map(|c| match c {
        Component::Normal(name) => name.to_str(),
        _ => None,
    });
    let profile = tail.next();
    let parent = tail.next();
    let cargo_build = parent == Some("target") && matches!(profile, Some("debug" | "release"));
    if cargo_build {
        POWERSHELL_APP_ID.to_string()
    } else {
        identifier.to_string()
    }
}

/// Windows: post the toast with WinRT directly. The plugin builds its own
/// toast XML with no launch URI, so it cannot ask for protocol activation.
#[cfg(windows)]
fn post_protocol_toast<R: Runtime>(app: &AppHandle<R>, xml: &str) -> windows::core::Result<()> {
    use tauri::Manager;
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let identifier = &app.config().identifier;
    let app_id = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| toast_app_id(dir, identifier)))
        .unwrap_or_else(|| identifier.clone());
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(xml))?;
    let toast = ToastNotification::CreateToastNotification(&doc)?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)
}

/// Posts the toast. `Ok(true)` once posted, `Ok(false)` when the OS refused
/// permission (nothing shown, so no `shown` receipt).
#[tauri::command]
pub fn show_banner<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
    open: Option<String>,
    receipt: Option<String>,
) -> Result<bool, String> {
    let notifier = app.notification();
    // Desktop reports Granted; ask anyway so a future platform that prompts
    // still asks on first need, never before.
    let state = notifier.permission_state().map_err(|e| e.to_string())?;
    let state = match state {
        PermissionState::Granted => state,
        _ => notifier.request_permission().map_err(|e| e.to_string())?,
    };
    if state != PermissionState::Granted {
        return Ok(false);
    }
    let (title, body) = sanitize(&title, &body);
    let open = open_path(open.as_deref());
    let receipt = receipt_id(receipt.as_deref());
    #[cfg(windows)]
    {
        let launch = toast_link::launch_uri(open.as_deref(), receipt.as_deref());
        match post_protocol_toast(&app, &toast_xml(&title, &body, &launch)) {
            Ok(()) => return Ok(true),
            // Still a toast, through the plugin: only an on-screen click
            // reaches the app then (on_action), not one from the Action Center.
            Err(err) => eprintln!("[banner] protocol toast failed, posting via the plugin: {err}"),
        }
    }
    let mut builder = notifier.builder().title(title).body(body);
    if let Some(path) = open {
        builder = builder.extra(OPEN_KEY, path);
    }
    if let Some(id) = receipt {
        builder = builder.extra(RECEIPT_KEY, id);
    }
    builder.show().map_err(|e| e.to_string())?;
    Ok(true)
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

    const ROW: &str = "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3c";

    #[test]
    fn a_receipt_id_is_only_a_bell_row_uuid() {
        assert_eq!(receipt_id(Some(ROW)), Some(ROW.into()));
        assert_eq!(
            receipt_id(Some(&ROW.to_uppercase())),
            Some(ROW.to_uppercase())
        );
        for bad in [
            "",
            "n1",
            &format!("missed:{ROW}")[..],
            &ROW[1..],
            &format!("{ROW}0")[..],
            "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3'",
            "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3g",
            "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3\n",
            "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3\\",
            "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3<",
            // 36 bytes, 34 characters: never mistaken for a uuid.
            "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9가",
        ] {
            assert_eq!(receipt_id(Some(bad)), None, "{bad}");
        }
        assert_eq!(receipt_id(None), None);
    }

    #[test]
    fn only_a_click_on_the_toast_reports_its_receipt() {
        assert_eq!(tap_receipt("tap", Some(ROW)), Some(ROW.into()));
        assert_eq!(tap_receipt("reply", Some(ROW)), None);
        assert_eq!(tap_receipt("tap", Some("n1")), None);
        assert_eq!(tap_receipt("tap", None), None);
    }

    #[test]
    fn the_click_script_reports_through_the_web_app_hook() {
        assert_eq!(
            click_script(ROW),
            format!("window.__klornToastClicked && window.__klornToastClicked('{ROW}');")
        );
    }

    #[test]
    fn the_windows_toast_launches_its_click_by_protocol() {
        assert_eq!(
            toast_xml("Kim", "Signed contract\nWhy it matters", "klorn://toast?open=/today"),
            "<toast activationType=\"protocol\" launch=\"klorn://toast?open=/today\"><visual><binding template=\"ToastGeneric\"><text>Kim</text><text>Signed contract</text><text>Why it matters</text></binding></visual></toast>"
        );
    }

    #[test]
    fn the_windows_toast_keeps_mail_text_as_text() {
        // A subject is attacker-chosen: it must never become markup.
        let xml = toast_xml(
            "<b>\"Kim\" & 'Lee'</b>",
            "</text><action/>",
            &toast_link::launch_uri(Some("/email/x1"), Some(ROW)),
        );
        assert!(
            xml.contains("<text>&lt;b&gt;&quot;Kim&quot; &amp; &apos;Lee&apos;&lt;/b&gt;</text>")
        );
        assert!(xml.contains("<text>&lt;/text&gt;&lt;action/&gt;</text>"));
        assert!(xml.contains(&format!(
            "launch=\"klorn://toast?open=/email/x1&amp;receipt={ROW}\""
        )));
        assert_eq!(xml.matches("<text>").count(), 2);
    }

    #[test]
    fn toasts_post_under_the_installed_app_id_or_powershell_for_a_cargo_build() {
        let id = "ai.klorn.desktop.win";
        for installed in ["C:/Users/u/AppData/Local/Klorn", "/opt/Klorn", "C:/target"] {
            assert_eq!(toast_app_id(Path::new(installed), id), id, "{installed}");
        }
        for cargo in ["C:/src/klorn/target/debug", "/src/target/release"] {
            assert_eq!(
                toast_app_id(Path::new(cargo), id),
                POWERSHELL_APP_ID,
                "{cargo}"
            );
        }
    }

    #[test]
    fn blank_title_falls_back_to_klorn() {
        assert_eq!(sanitize("  \n", "body").0, "Klorn");
    }
}

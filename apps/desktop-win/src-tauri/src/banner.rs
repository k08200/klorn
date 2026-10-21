//! The one IPC command the remote page may call to post an OS banner.
//!
//! The notification plugin's own `notify` command accepts the whole
//! NotificationData (icon path, attachments, schedule, sound, ...). On Windows
//! an icon becomes a `file:///` image source, so a compromised page could
//! point it at a UNC path. Instead the remote capability grants only this
//! command: title and body as plain text, length-clamped here, everything
//! else fixed by the shell.

use tauri::plugin::PermissionState;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

pub const TITLE_MAX: usize = 120;
pub const BODY_MAX: usize = 240;
const FALLBACK_TITLE: &str = "Klorn";

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

/// The banner text the shell will actually post. Pure.
pub fn sanitize(title: &str, body: &str) -> (String, String) {
    let title = clean(title, TITLE_MAX);
    let title = if title.is_empty() {
        FALLBACK_TITLE.to_string()
    } else {
        title
    };
    (title, clean(body, BODY_MAX))
}

#[tauri::command]
pub fn show_banner<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
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
    notifier
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
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
        assert_eq!(sanitize("x", "a\r\nb").1, "ab");
    }

    #[test]
    fn blank_title_falls_back_to_klorn() {
        assert_eq!(sanitize("  \n", "body").0, "Klorn");
    }
}

//! A click on a Klorn toast, delivered as a `klorn://toast?…` launch — the
//! only way one reaches the app from the Action Center.
//!
//! Why: the notification plugin learns of a click only while the toast is on
//! screen (tauri-plugin-notification 2.7 `NotificationBuilder::show` docs). Its
//! notify-rust wait thread takes ONE event per toast and ends when the toast
//! times out into the Action Center, so a later click there opened nothing and
//! reported no `clicked` receipt. This shell is unpackaged and its installer
//! registers no COM activator (Tauri's NSIS template only stamps the
//! AppUserModelID on the shortcut), so Windows has no in-process callback for
//! such a click. What Windows does run for any app is a toast whose `launch`
//! is a URI with `activationType="protocol"`: a click on it — on screen or in
//! the Action Center, with Klorn running or quit — launches
//! `Klorn.exe "<uri>"` through the `klorn` scheme the installer registers
//! (tauri.conf.json `plugins.deep-link.desktop`). A running Klorn gets the
//! URI from the single-instance plugin; a quit one starts with it.
//!
//! Any web page can open a `klorn://` link too, after the browser's own "Open
//! Klorn?" prompt. It can do no more than a toast click: show the window, open
//! Today or one mail by id (`open_path`), and report `clicked` for a bell row
//! id (`receipt_id`) — which the receipts endpoint accepts only for the
//! caller's own rows, stamping the first report only.

use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Manager, Runtime, Url, WebviewWindow};

use crate::banner::{click_script, open_path, open_script, receipt_id};
use crate::tray;

const PREFIX: &str = "klorn://toast";
const OPEN_PARAM: &str = "open";
const RECEIPT_PARAM: &str = "receipt";
/// Longest argument read as a toast link. The longest valid one is about 130
/// characters (a 64-character mail id and a 36-character row id).
const URI_MAX: usize = 256;
/// Cold start: how long the receipt waits for the web app's click hook.
const HOOK_POLL_MS: u32 = 200;
const HOOK_POLL_TRIES: u32 = 50;

/// What a toast click asks for. Both parts already passed the shell's checks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToastClick {
    /// The page to open (`open_path`).
    pub open: Option<String>,
    /// The bell row id to report `clicked` for (`receipt_id`).
    pub receipt: Option<String>,
}

/// The URI a toast launches when clicked. A value that fails the shell's
/// checks is left out; with neither, a click only brings the window back.
/// Pure.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn launch_uri(open: Option<&str>, receipt: Option<&str>) -> String {
    let mut params = Vec::new();
    if let Some(path) = open_path(open) {
        params.push(format!("{OPEN_PARAM}={path}"));
    }
    if let Some(id) = receipt_id(receipt) {
        params.push(format!("{RECEIPT_PARAM}={id}"));
    }
    if params.is_empty() {
        PREFIX.to_string()
    } else {
        format!("{PREFIX}?{}", params.join("&"))
    }
}

/// The click a launch argument carries, or None when it is not a toast link.
/// Unknown parameters and values that fail the shell's checks are dropped; of
/// a repeated parameter, the first valid value counts. Pure.
pub fn parse(arg: &str) -> Option<ToastClick> {
    if arg.len() > URI_MAX {
        return None;
    }
    let rest = arg.strip_prefix(PREFIX)?;
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let query = if rest.is_empty() {
        rest
    } else {
        rest.strip_prefix('?')?
    };
    let mut click = ToastClick::default();
    for (key, value) in query.split('&').filter_map(|pair| pair.split_once('=')) {
        match key {
            OPEN_PARAM if click.open.is_none() => click.open = open_path(Some(value)),
            RECEIPT_PARAM if click.receipt.is_none() => click.receipt = receipt_id(Some(value)),
            _ => {}
        }
    }
    Some(click)
}

/// The toast click among a process's arguments (the first is the program).
/// Pure.
pub fn from_args<I, S>(args: I) -> Option<ToastClick>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().skip(1).find_map(|arg| parse(arg.as_ref()))
}

/// A click while Klorn runs (the toast's own click, or a protocol launch the
/// single-instance plugin forwarded): bring the window back, hand the receipt
/// to the web app, then open the page.
pub fn deliver<R: Runtime>(app: &AppHandle<R>, click: &ToastClick) {
    tray::show_main(app);
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    // The receipt first, so its request is already queued when the page
    // routes. The hook is installed with the router (desktop-toast-router.tsx):
    // while neither is mounted, the click is not reported and the open script
    // falls back to a plain navigation.
    if let Some(id) = &click.receipt {
        let _ = win.eval(click_script(id));
    }
    if let Some(path) = &click.open {
        let _ = win.eval(open_script(path));
    }
}

/// A receipt held for the page a cold start opens: reported once that page
/// has loaded, not on the sign-in page loading underneath it.
#[derive(Debug, Default)]
pub struct PendingReceipt(Mutex<Option<(String, Option<String>)>>);

impl PendingReceipt {
    fn slot(&self) -> MutexGuard<'_, Option<(String, Option<String>)>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Hold `id` until a page at `path` (any page when None) has loaded.
    pub fn hold(&self, id: String, path: Option<String>) {
        *self.slot() = Some((id, path));
    }

    /// The held receipt, taken, when the page at `loaded_path` is the one it
    /// waits for.
    pub fn take_for(&self, loaded_path: &str) -> Option<String> {
        let mut slot = self.slot();
        let waits_here = match slot.as_ref() {
            Some((_, Some(path))) => path == loaded_path,
            Some((_, None)) => true,
            None => false,
        };
        if !waits_here {
            return None;
        }
        slot.take().map(|(id, _)| id)
    }
}

/// Script for a cold start's receipt: the web app installs its click hook
/// only after it hydrates, so wait for it (about 10 s at most) instead of
/// dropping the report. `id` must come from `receipt_id`. Pure.
pub fn pending_click_script(id: &str) -> String {
    format!(
        "(function(){{var n=0;(function t(){{if(window.__klornToastClicked){{window.__klornToastClicked('{id}');}}else if(n++<{HOOK_POLL_TRIES}){{setTimeout(t,{HOOK_POLL_MS});}}}})();}})();"
    )
}

/// The page to load for a click that started Klorn: the same origin as the
/// window's start page, at the click's path. Pure.
pub fn launch_url(start: &Url, path: &str) -> Option<Url> {
    start.join(path).ok()
}

/// A click that started Klorn: open its page in place of the start page, and
/// hold its receipt until that page has loaded (main.rs `on_page_load`).
pub fn open_on_launch<R: Runtime>(
    win: &WebviewWindow<R>,
    click: &ToastClick,
    pending: &PendingReceipt,
) {
    if let Some(id) = &click.receipt {
        pending.hold(id.clone(), click.open.clone());
    }
    let Some(path) = &click.open else {
        return;
    };
    if let Some(url) = win.url().ok().and_then(|start| launch_url(&start, path)) {
        let _ = win.navigate(url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROW: &str = "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3c";

    #[test]
    fn a_toast_launches_its_page_and_receipt() {
        assert_eq!(
            launch_uri(Some("/email/cm3abc_9-Z"), Some(ROW)),
            format!("klorn://toast?open=/email/cm3abc_9-Z&receipt={ROW}")
        );
        assert_eq!(
            launch_uri(Some("/today"), None),
            "klorn://toast?open=/today"
        );
        assert_eq!(launch_uri(None, None), "klorn://toast");
    }

    #[test]
    fn a_launch_drops_what_the_shell_would_refuse() {
        assert_eq!(
            launch_uri(Some("https://evil.example"), Some("n1")),
            "klorn://toast"
        );
    }

    #[test]
    fn a_launch_round_trips() {
        let uri = launch_uri(Some("/email/x1"), Some(ROW));
        assert_eq!(
            parse(&uri),
            Some(ToastClick {
                open: Some("/email/x1".into()),
                receipt: Some(ROW.into()),
            })
        );
        assert_eq!(parse("klorn://toast"), Some(ToastClick::default()));
        assert_eq!(
            parse("klorn://toast/?open=/today"),
            Some(ToastClick {
                open: Some("/today".into()),
                receipt: None,
            })
        );
    }

    #[test]
    fn only_a_toast_link_is_a_click() {
        for other in [
            "C:\\Program Files\\Klorn\\Klorn.exe",
            "--autostart",
            "klorn://other?open=/today",
            "klorn://toastx?open=/today",
            "klorn://toast#open=/today",
            "https://app.klorn.ai/today",
            "",
        ] {
            assert_eq!(parse(other), None, "{other}");
        }
        assert_eq!(
            parse(&format!(
                "klorn://toast?open=/today&pad={}",
                "a".repeat(URI_MAX)
            )),
            None
        );
    }

    #[test]
    fn a_link_cannot_smuggle_a_page_or_a_script() {
        let cases: [(&str, Option<&str>, Option<&str>); 8] = [
            ("klorn://toast?open=//evil.example", None, None),
            ("klorn://toast?open=/settings", None, None),
            ("klorn://toast?open=/email/a'b", None, None),
            ("klorn://toast?open=javascript:alert(1)", None, None),
            ("klorn://toast?receipt=n1&open=/today", Some("/today"), None),
            (
                "klorn://toast?open=/email/a%27b&receipt=0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3'",
                None,
                None,
            ),
            (
                "klorn://toast?open=/settings&open=/today",
                Some("/today"),
                None,
            ),
            ("klorn://toast?open", None, None),
        ];
        for (uri, open, receipt) in cases {
            assert_eq!(
                parse(uri),
                Some(ToastClick {
                    open: open.map(Into::into),
                    receipt: receipt.map(Into::into),
                }),
                "{uri}"
            );
        }
    }

    #[test]
    fn the_click_is_found_among_the_launch_arguments() {
        let args = [
            "C:\\Klorn\\Klorn.exe".to_string(),
            "klorn://toast?open=/today".to_string(),
        ];
        assert_eq!(
            from_args(args),
            Some(ToastClick {
                open: Some("/today".into()),
                receipt: None,
            })
        );
        // The program path is never read as a link, even a hostile one.
        assert_eq!(from_args(["klorn://toast?open=/today"]), None);
        assert_eq!(from_args(["Klorn.exe", "--autostart"]), None);
    }

    #[test]
    fn a_cold_start_opens_the_page_on_the_start_origin() {
        let start = Url::parse("https://app.klorn.ai/login").unwrap();
        assert_eq!(
            launch_url(&start, "/email/x1").unwrap().as_str(),
            "https://app.klorn.ai/email/x1"
        );
    }

    #[test]
    fn a_held_receipt_waits_for_its_own_page_and_is_reported_once() {
        let pending = PendingReceipt::default();
        pending.hold(ROW.into(), Some("/email/x1".into()));
        assert_eq!(pending.take_for("/login"), None);
        assert_eq!(pending.take_for("/email/x1"), Some(ROW.into()));
        assert_eq!(pending.take_for("/email/x1"), None);

        pending.hold(ROW.into(), None);
        assert_eq!(pending.take_for("/today"), Some(ROW.into()));
    }

    #[test]
    fn the_cold_start_script_waits_for_the_web_app_hook() {
        let script = pending_click_script(ROW);
        assert!(script.contains(&format!("window.__klornToastClicked('{ROW}')")));
        assert!(script.contains("setTimeout(t,200)"));
        assert!(script.contains("n++<50"));
    }
}

//! Close-to-tray. Closing the main window hides it instead of quitting, so the
//! web app keeps its real-time connection and can still raise PUSH / meeting
//! banners; the tray icon brings the window back or quits for real.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

const MAIN_WINDOW: &str = "main";
const MENU_OPEN: &str = "open";
const MENU_QUIT: &str = "quit";

/// Tray menu copy. The shell has no web-side i18n, so the two strings live
/// here; anything that is not Korean reads English.
#[derive(Debug, PartialEq, Eq)]
pub struct TrayLabels {
    pub open: &'static str,
    pub quit: &'static str,
}

const EN: TrayLabels = TrayLabels {
    open: "Open Klorn",
    quit: "Quit Klorn",
};
const KO: TrayLabels = TrayLabels {
    open: "Klorn 열기",
    quit: "Klorn 종료",
};

/// Labels for a BCP-47 locale tag ("ko-KR", "ko", "en-US"). Pure.
pub fn labels_for(locale: Option<&str>) -> &'static TrayLabels {
    match locale {
        Some(tag) if tag.to_ascii_lowercase().starts_with("ko") => &KO,
        _ => &EN,
    }
}

/// Bring the main window back: un-hide, un-minimize, focus.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let labels = labels_for(sys_locale::get_locale().as_deref());
    let open = MenuItem::with_id(app, MENU_OPEN, labels.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut builder = TrayIconBuilder::with_id("klorn-tray")
        .tooltip("Klorn")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main(app),
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn korean_locales_get_korean_labels() {
        assert_eq!(labels_for(Some("ko-KR")), &KO);
        assert_eq!(labels_for(Some("ko")), &KO);
        assert_eq!(labels_for(Some("KO-kr")), &KO);
    }

    #[test]
    fn everything_else_reads_english() {
        assert_eq!(labels_for(Some("en-US")), &EN);
        assert_eq!(labels_for(Some("ja-JP")), &EN);
        assert_eq!(labels_for(Some("")), &EN);
        assert_eq!(labels_for(None), &EN);
    }
}

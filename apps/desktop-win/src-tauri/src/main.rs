// Klorn for Windows — a Tauri shell around the hosted web app.
//
// This is deliberately thin: the window IS app.klorn.ai. Everything the shell
// adds is listed here, and nothing else:
//   • single instance — a second launch shows and focuses the first window
//   • the opener plugin — so the web app's shell.ts can hand Google OAuth to
//     the SYSTEM browser (Google rejects OAuth inside embedded webviews)
//   • OS banners for PUSH mail and meetings starting soon — the web app
//     (lib/native/tauri-notify.ts) calls our `show_banner` command (banner.rs,
//     title + body + the page a click opens: Today or one mail); the plugin's
//     own commands are NOT exposed to it. A click — on screen or from the
//     Action Center — launches `klorn://toast?…` (toast_link.rs): it brings
//     the window back and opens that page, starting Klorn if it was quit
//   • close-to-tray (tray.rs) — closing hides the window so banners keep
//     arriving; the tray's Quit really quits
//   • start at sign-in (autostart.rs) — opt-in, OFF until the user says yes
//     in the web app; a login launch starts in the tray
//   • a window background matched to the OS theme (theme.rs) — no white flash
// The web app detects this shell via the injected IPC global
// (window.__TAURI_INTERNALS__) and takes its PKCE poll login flow; the deep
// link relay flow stays Capacitor-only.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autostart;
mod banner;
mod theme;
mod toast_link;
mod tray;

use std::time::Instant;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewUrl, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use toast_link::PendingReceipt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A toast click (on screen or from the Action Center) while Klorn
            // runs arrives as a second launch with its klorn:// link.
            if let Some(click) = toast_link::from_args(&args) {
                toast_link::deliver(app, &click);
                return;
            }
            // A sign-in launch while Klorn already runs stays in the tray.
            if !autostart::launched_at_login(&args) {
                tray::show_main(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(autostart::plugin())
        .invoke_handler(tauri::generate_handler![banner::show_banner])
        .manage(PendingReceipt::default())
        // A toast click that started Klorn: its receipt waits for the page it
        // opened (toast_link::open_on_launch) and the web app's click hook.
        .on_page_load(|webview, payload| {
            if webview.label() != "main" || payload.event() != PageLoadEvent::Finished {
                return;
            }
            let pending = webview.state::<PendingReceipt>();
            if let Some(id) = pending.for_page(payload.url(), Instant::now()) {
                let _ = webview.eval(toast_link::pending_click_script(&id));
            }
        })
        .setup(|app| {
            // Fatal on purpose: close-to-tray below hides the window, so
            // without a tray there would be no way back to it.
            tray::install(app.handle())?;
            // A click on a banner opens its page in the main window.
            let handle = app.handle().clone();
            app.notification()
                .on_action(move |performed| banner::on_action(&handle, performed))?;
            if let Some(win) = app.get_webview_window("main") {
                // Declared hidden in tauri.conf.json: paint first, then show —
                // unless Windows started us at sign-in: then the tray only.
                theme::paint(&win, win.theme().unwrap_or(tauri::Theme::Light));
                if !autostart::launched_at_login(std::env::args()) {
                    win.show()?;
                }
                // Started by a click on a toast in the Action Center.
                if let Some(click) = toast_link::from_args(std::env::args()) {
                    let configured = app
                        .config()
                        .app
                        .windows
                        .iter()
                        .find(|w| w.label == "main")
                        .and_then(|w| match &w.url {
                            WebviewUrl::External(url) => Some(url.clone()),
                            _ => None,
                        });
                    toast_link::open_on_launch(
                        &win,
                        configured.as_ref(),
                        &click,
                        &app.state::<PendingReceipt>(),
                        Instant::now(),
                    );
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::ThemeChanged(theme) => {
                if let Some(win) = window.app_handle().get_webview_window(window.label()) {
                    theme::paint(&win, *theme);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("failed to launch Klorn");
}

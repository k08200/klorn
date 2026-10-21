// Klorn for Windows — a Tauri shell around the hosted web app.
//
// This is deliberately thin: the window IS app.klorn.ai. Everything the shell
// adds is listed here, and nothing else:
//   • single instance — a second launch shows and focuses the first window
//   • the opener plugin — so the web app's shell.ts can hand Google OAuth to
//     the SYSTEM browser (Google rejects OAuth inside embedded webviews)
//   • OS banners for PUSH mail and meetings starting soon — the web app
//     (lib/native/tauri-notify.ts) calls our `show_banner` command (banner.rs,
//     title + body only); the plugin's own commands are NOT exposed to it
//   • close-to-tray (tray.rs) — closing hides the window so banners keep
//     arriving; the tray's Quit really quits
//   • a window background matched to the OS theme (theme.rs) — no white flash
// The web app detects this shell via the injected IPC global
// (window.__TAURI_INTERNALS__) and takes its PKCE poll login flow; the deep
// link relay flow stays Capacitor-only.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod banner;
mod theme;
mod tray;

use tauri::{Manager, WindowEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![banner::show_banner])
        .setup(|app| {
            // Fatal on purpose: close-to-tray below hides the window, so
            // without a tray there would be no way back to it.
            tray::install(app.handle())?;
            if let Some(win) = app.get_webview_window("main") {
                // Declared hidden in tauri.conf.json: paint first, then show.
                theme::paint(&win, win.theme().unwrap_or(tauri::Theme::Light));
                win.show()?;
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

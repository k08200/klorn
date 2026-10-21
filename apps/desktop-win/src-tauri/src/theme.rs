//! Window background that matches the app canvas, so the frame does not flash
//! white (dark OS) or near-black (light OS) before app.klorn.ai paints.
//!
//! Tauri v2's static config cannot pick a colour by OS theme, so the window is
//! declared hidden in tauri.conf.json; setup paints the background for the
//! current OS theme and then shows it, and a theme change repaints it.

use tauri::window::Color;
use tauri::{Runtime, Theme, WebviewWindow};

/// The web app's canvas: `#0A0A0B` dark, white light.
pub const DARK_CANVAS: Color = Color(0x0A, 0x0A, 0x0B, 0xFF);
pub const LIGHT_CANVAS: Color = Color(0xFF, 0xFF, 0xFF, 0xFF);

/// Canvas colour for an OS theme. Unknown future variants read light, the
/// WebView2 default. Pure.
pub fn canvas_for(theme: Theme) -> Color {
    match theme {
        Theme::Dark => DARK_CANVAS,
        _ => LIGHT_CANVAS,
    }
}

pub fn paint<R: Runtime>(win: &WebviewWindow<R>, theme: Theme) {
    let _ = win.set_background_color(Some(canvas_for(theme)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_os_gets_the_dark_canvas() {
        assert_eq!(canvas_for(Theme::Dark), Color(0x0A, 0x0A, 0x0B, 0xFF));
    }

    #[test]
    fn light_os_gets_white() {
        assert_eq!(canvas_for(Theme::Light), Color(0xFF, 0xFF, 0xFF, 0xFF));
    }
}

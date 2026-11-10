//! Start at sign-in (tauri-plugin-autostart). Opt-in, like the Mac's login
//! item: OFF until the user accepts the web app's one-time prompt or flips the
//! Settings toggle — the shell never enables it on its own.
//!
//! The remote page drives it through the plugin's three commands (enable,
//! disable, is_enabled — granted in capabilities/default.json). None takes an
//! argument: the Run entry's program path and arguments are fixed here.
//!
//! A login launch carries LOGIN_ARG and starts in the tray (window hidden),
//! so signing in to Windows does not throw a window in the user's face; the
//! hidden webview still loads the app and receives banners, exactly as after
//! close-to-tray.

use tauri::plugin::TauriPlugin;
use tauri::Runtime;

/// Appended to the Run entry, so the shell can tell a login launch apart.
pub const LOGIN_ARG: &str = "--autostart";

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_autostart::Builder::new()
        .arg(LOGIN_ARG)
        .build()
}

/// True when this process (argv, program path first) was started by the
/// sign-in Run entry. Pure.
pub fn launched_at_login<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .any(|arg| arg.as_ref() == LOGIN_ARG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_login_launch_carries_the_marker() {
        assert!(launched_at_login(["C:\\Klorn\\Klorn.exe", LOGIN_ARG]));
    }

    #[test]
    fn a_normal_launch_does_not() {
        assert!(!launched_at_login(["C:\\Klorn\\Klorn.exe"]));
        assert!(!launched_at_login(["C:\\Klorn\\Klorn.exe", "--other"]));
    }

    #[test]
    fn the_program_path_itself_is_never_read_as_the_marker() {
        assert!(!launched_at_login([LOGIN_ARG]));
    }
}

fn main() {
    // Declaring the app's commands generates `allow-show-banner`, so the
    // remote capability must name it explicitly (capabilities/default.json).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["show_banner"])),
    )
    .expect("failed to run tauri-build");
}

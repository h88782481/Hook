fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=windows/app.manifest");

    let mut attrs = tauri_build::Attributes::new();

    // Release / packaged builds request admin so hooks work against elevated windows.
    // Keep `tauri dev` asInvoker to avoid UAC on every hot reload.
    #[cfg(windows)]
    if !tauri_build::is_dev() {
        let windows = tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("windows/app.manifest"));
        attrs = attrs.windows_attributes(windows);
    }

    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}

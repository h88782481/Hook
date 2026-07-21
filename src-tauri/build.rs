fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    tauri_build::try_build(tauri_build::Attributes::new())
        .expect("failed to run tauri build script");
}

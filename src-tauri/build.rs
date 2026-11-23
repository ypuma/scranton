fn main() {
    let target = std::env::var("TARGET").expect("Cargo TARGET is required");
    println!("cargo:rustc-env=SCRANTON_RUST_TARGET={target}");
    println!("cargo:rerun-if-env-changed=TARGET");
    println!("cargo:rerun-if-changed=permissions");
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().permissions_path_pattern("permissions/*.toml"),
        ),
    ).expect("Cannot build Scranton desktop metadata");
}

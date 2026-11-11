fn main() {
    let target = std::env::var("TARGET").expect("Cargo TARGET is required");
    println!("cargo:rustc-env=SCRANTON_RUST_TARGET={target}");
    println!("cargo:rerun-if-env-changed=TARGET");
    tauri_build::build()
}

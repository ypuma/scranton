#[cfg(windows)]
mod windows;
fn main() {
    #[cfg(windows)]
    match windows::main_result() {
        Ok(code) => std::process::exit(code as i32),
        Err(error) => { eprintln!("Sandbox setup failed: {error}"); std::process::exit(125); }
    }
    #[cfg(not(windows))]
    { eprintln!("This helper is Windows-only; use the Node Seatbelt/bubblewrap adapter."); std::process::exit(125); }
}

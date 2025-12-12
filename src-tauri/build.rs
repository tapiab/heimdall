use std::process::Command;

fn main() {
    // Get version from git tag
    let version = get_git_version().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    println!("cargo:rustc-env=HEIMDALL_VERSION={}", version);
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs/tags");

    tauri_build::build()
}

fn get_git_version() -> Option<String> {
    // Try to get version from git describe
    let output = Command::new("git")
        .args(["describe", "--tags", "--always", "--dirty"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if version.is_empty() {
        return None;
    }

    Some(version)
}

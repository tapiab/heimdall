/// Application-level commands

/// Get the application version from git tag (set at build time)
#[tauri::command]
pub fn get_version() -> String {
    env!("HEIMDALL_VERSION").to_string()
}

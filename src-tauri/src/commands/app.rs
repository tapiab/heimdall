//! Application-level commands

/// Get the application version from git tag (set at build time)
#[tauri::command]
pub fn get_version() -> String {
    env!("HEIMDALL_VERSION").to_string()
}

/// Read the config file from ~/.config/heimdall/config.json.
/// Returns the raw JSON string, or an empty string if the file doesn't exist.
#[tauri::command]
pub fn read_config() -> String {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return String::new(),
    };
    let path = home.join(".config").join("heimdall").join("config.json");
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Write the config file to ~/.config/heimdall/config.json.
#[tauri::command]
pub fn write_config(content: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let dir = home.join(".config").join("heimdall");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    std::fs::write(dir.join("config.json"), content)
        .map_err(|e| format!("Failed to write config: {}", e))
}

use serde::Serialize;

/// Configuration handed to the webview so the frontend knows where the
/// Actix-web REST backend lives and how the store name should be shown.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiConfig {
    api_base_url: String,
    store_name: String,
}

fn resolve_api_base_url() -> String {
    let raw = std::env::var("API_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string());
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        "http://127.0.0.1:8080".to_string()
    } else {
        trimmed
    }
}

/// Exposed to the frontend via `window.__TAURI__.core.invoke('get_config')`.
#[tauri::command]
fn get_config() -> ApiConfig {
    ApiConfig {
        api_base_url: resolve_api_base_url(),
        store_name: std::env::var("STORE_NAME").unwrap_or_else(|_| "BackPOS Store".to_string()),
    }
}

fn load_env_files() {
    // Try CWD-relative locations first (cargo run / tauri dev).
    let _ = dotenvy::from_path("src-tauri/.env");
    let _ = dotenvy::from_path("../../.env");
    // Then exe-relative ones, so double-clicking the exe (or a bundled
    // install) still finds the config. dotenvy never overwrites variables
    // that are already set, so extra attempts are harmless.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    if let Some(dir) = exe_dir {
        let _ = dotenvy::from_path(dir.join(".env")); // installed bundle
        let _ = dotenvy::from_path(dir.join("../../.env")); // src-tauri/.env
        let _ = dotenvy::from_path(dir.join("../../../.env")); // desktop_pos/.env
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env files silently — a missing file is perfectly normal.
    load_env_files();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env files silently — a missing file is perfectly normal.
    let _ = dotenvy::from_path("src-tauri/.env");
    let _ = dotenvy::from_path("../../.env");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "deck-transfer-data.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: String,
    pub hostname: String,
    pub ip: String,
    pub password: String,
    pub connection_mode: String,
    pub last_used: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub path: String,
    pub label: String,
    pub connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub speed_limit: u64,
    pub auto_clear: bool,
    pub connection_mode: String,
    pub transfer_protocol: String,
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
}

fn default_true() -> bool { true }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            speed_limit: 0,
            auto_clear: false,
            connection_mode: "ethernet".to_string(),
            transfer_protocol: "sftp".to_string(),
            minimize_to_tray: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferStats {
    pub total_bytes: u64,
    pub total_files: u64,
    pub total_sessions: u64,
    pub avg_speed_bps: f64,
}

impl Default for TransferStats {
    fn default() -> Self {
        Self {
            total_bytes: 0,
            total_files: 0,
            total_sessions: 0,
            avg_speed_bps: 0.0,
        }
    }
}

fn get_store(app: &AppHandle) -> Result<std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>, String> {
    app.store(STORE_FILE).map_err(|e| format!("Store error: {}", e))
}

// --- Connections ---

#[tauri::command]
pub async fn save_connection(app: AppHandle, connection: SavedConnection) -> Result<(), String> {
    let store = get_store(&app)?;
    let mut connections: Vec<SavedConnection> = store
        .get("connections")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    // Update existing or add new
    if let Some(existing) = connections.iter_mut().find(|c| c.id == connection.id) {
        *existing = connection;
    } else {
        connections.push(connection);
    }

    store.set("connections", serde_json::to_value(&connections).map_err(|e| e.to_string())?);
    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn get_connections(app: AppHandle) -> Result<Vec<SavedConnection>, String> {
    let store = get_store(&app)?;
    let connections: Vec<SavedConnection> = store
        .get("connections")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    Ok(connections)
}

#[tauri::command]
pub async fn delete_connection(app: AppHandle, id: String) -> Result<(), String> {
    let store = get_store(&app)?;
    let mut connections: Vec<SavedConnection> = store
        .get("connections")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    connections.retain(|c| c.id != id);
    store.set("connections", serde_json::to_value(&connections).map_err(|e| e.to_string())?);
    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

// --- Bookmarks ---

#[tauri::command]
pub async fn save_bookmark(app: AppHandle, bookmark: Bookmark) -> Result<(), String> {
    let store = get_store(&app)?;
    let mut bookmarks: Vec<Bookmark> = store
        .get("bookmarks")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    if let Some(existing) = bookmarks.iter_mut().find(|b| b.id == bookmark.id) {
        *existing = bookmark;
    } else {
        bookmarks.push(bookmark);
    }

    store.set("bookmarks", serde_json::to_value(&bookmarks).map_err(|e| e.to_string())?);
    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn get_bookmarks(app: AppHandle) -> Result<Vec<Bookmark>, String> {
    let store = get_store(&app)?;
    let bookmarks: Vec<Bookmark> = store
        .get("bookmarks")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    Ok(bookmarks)
}

#[tauri::command]
pub async fn delete_bookmark(app: AppHandle, id: String) -> Result<(), String> {
    let store = get_store(&app)?;
    let mut bookmarks: Vec<Bookmark> = store
        .get("bookmarks")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    bookmarks.retain(|b| b.id != id);
    store.set("bookmarks", serde_json::to_value(&bookmarks).map_err(|e| e.to_string())?);
    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

// --- Settings ---

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let store = get_store(&app)?;
    store.set("settings", serde_json::to_value(&settings).map_err(|e| e.to_string())?);
    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let store = get_store(&app)?;
    let settings: AppSettings = store
        .get("settings")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    Ok(settings)
}

// --- Transfer Stats ---

#[tauri::command]
pub async fn get_transfer_stats(app: AppHandle) -> Result<TransferStats, String> {
    let store = get_store(&app)?;
    let stats: TransferStats = store
        .get("transfer_stats")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    Ok(stats)
}

#[tauri::command]
pub async fn update_transfer_stats(
    app: AppHandle,
    bytes: u64,
    files: u64,
    speed: f64,
) -> Result<(), String> {
    let store = get_store(&app)?;
    let mut stats: TransferStats = store
        .get("transfer_stats")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    stats.total_bytes += bytes;
    stats.total_files += files;
    stats.total_sessions += 1;
    // Running average
    if stats.total_sessions == 1 {
        stats.avg_speed_bps = speed;
    } else {
        stats.avg_speed_bps =
            stats.avg_speed_bps + (speed - stats.avg_speed_bps) / stats.total_sessions as f64;
    }

    store.set("transfer_stats", serde_json::to_value(&stats).map_err(|e| e.to_string())?);
    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

// --- Export / Import ---

#[tauri::command]
pub async fn export_profile(app: AppHandle) -> Result<String, String> {
    let store = get_store(&app)?;
    let connections: Vec<SavedConnection> = store
        .get("connections")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let bookmarks: Vec<Bookmark> = store
        .get("bookmarks")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let settings: AppSettings = store
        .get("settings")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let export = serde_json::json!({
        "version": "0.3.0",
        "connections": connections,
        "bookmarks": bookmarks,
        "settings": settings,
    });

    serde_json::to_string_pretty(&export).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_profile(app: AppHandle, json: String) -> Result<(), String> {
    let data: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("Invalid JSON: {}", e))?;

    let store = get_store(&app)?;

    if let Some(connections) = data.get("connections") {
        store.set("connections", connections.clone());
    }
    if let Some(bookmarks) = data.get("bookmarks") {
        store.set("bookmarks", bookmarks.clone());
    }
    if let Some(settings) = data.get("settings") {
        store.set("settings", settings.clone());
    }

    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

// --- Pro Status Cache ---

#[tauri::command]
pub async fn save_pro_status(app: AppHandle, json: String) -> Result<(), String> {
    let store = get_store(&app)?;
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("Invalid JSON: {}", e))?;
    store.set("pro_status", value);
    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn load_pro_status(app: AppHandle) -> Result<String, String> {
    let store = get_store(&app)?;
    match store.get("pro_status") {
        Some(value) => serde_json::to_string(&value).map_err(|e| e.to_string()),
        None => Err("No pro status cached".to_string()),
    }
}

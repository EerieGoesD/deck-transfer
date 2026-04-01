use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

const HISTORY_FILE: &str = "transfer-history.json";
const MAX_HISTORY: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferRecord {
    pub id: String,
    pub file_name: String,
    pub file_path: String,
    pub file_size: u64,
    pub remote_dir: String,
    pub deck_ip: String,
    pub protocol: String,
    pub status: String, // "complete" | "error"
    pub error: Option<String>,
    pub speed_bps: f64,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryData {
    records: Vec<TransferRecord>,
}

fn history_path(app: &AppHandle) -> PathBuf {
    let data_dir = app.path().app_data_dir().expect("No app data dir");
    fs::create_dir_all(&data_dir).ok();
    data_dir.join(HISTORY_FILE)
}

fn load_history(app: &AppHandle) -> HistoryData {
    let path = history_path(app);
    if !path.exists() {
        return HistoryData { records: vec![] };
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(HistoryData { records: vec![] }),
        Err(_) => HistoryData { records: vec![] },
    }
}

fn save_history(app: &AppHandle, data: &HistoryData) -> Result<(), String> {
    let path = history_path(app);
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to write history: {}", e))
}

#[tauri::command]
pub async fn record_transfer(app: AppHandle, record: TransferRecord) -> Result<(), String> {
    let mut data = load_history(&app);
    data.records.insert(0, record);
    // Cap at MAX_HISTORY
    data.records.truncate(MAX_HISTORY);
    save_history(&app, &data)
}

#[tauri::command]
pub async fn record_transfers_batch(
    app: AppHandle,
    records: Vec<TransferRecord>,
) -> Result<(), String> {
    let mut data = load_history(&app);
    for record in records.into_iter().rev() {
        data.records.insert(0, record);
    }
    data.records.truncate(MAX_HISTORY);
    save_history(&app, &data)
}

#[tauri::command]
pub async fn get_transfer_history(
    app: AppHandle,
    limit: usize,
    offset: usize,
) -> Result<Vec<TransferRecord>, String> {
    let data = load_history(&app);
    let records: Vec<TransferRecord> = data
        .records
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect();
    Ok(records)
}

#[tauri::command]
pub async fn get_history_count(app: AppHandle) -> Result<usize, String> {
    let data = load_history(&app);
    Ok(data.records.len())
}

#[tauri::command]
pub async fn clear_transfer_history(app: AppHandle) -> Result<(), String> {
    let data = HistoryData { records: vec![] };
    save_history(&app, &data)
}

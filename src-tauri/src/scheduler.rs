use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use tauri_plugin_notification::NotificationExt;

use crate::{dbg_log, SPEED_LIMIT};

const STORE_FILE: &str = "deck-transfer-data.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleConfig {
    pub id: String,
    pub name: String,
    pub schedule_type: String, // "sync" | "transfer"
    pub local_dir: String,
    pub remote_dir: String,
    pub deck_ip: String,
    pub deck_password: String,
    pub hour: u32,
    pub minute: u32,
    pub enabled: bool,
    pub last_run: Option<String>,
    pub speed_limit: u64,
}

static SCHEDULES_CACHE: once_cell::sync::Lazy<Mutex<Vec<ScheduleConfig>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Vec::new()));

fn load_schedules_from_store(app: &AppHandle) -> Vec<ScheduleConfig> {
    match app.store(STORE_FILE) {
        Ok(store) => store
            .get("schedules")
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_schedules_to_store(app: &AppHandle, schedules: &[ScheduleConfig]) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| format!("Store error: {}", e))?;
    store.set(
        "schedules",
        serde_json::to_value(schedules).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn create_schedule(app: AppHandle, schedule: ScheduleConfig) -> Result<(), String> {
    let mut cache = SCHEDULES_CACHE.lock().unwrap();
    // Update existing or add new
    if let Some(existing) = cache.iter_mut().find(|s| s.id == schedule.id) {
        *existing = schedule;
    } else {
        cache.push(schedule);
    }
    let schedules = cache.clone();
    drop(cache);
    save_schedules_to_store(&app, &schedules)
}

#[tauri::command]
pub async fn get_schedules(app: AppHandle) -> Result<Vec<ScheduleConfig>, String> {
    let schedules = load_schedules_from_store(&app);
    let mut cache = SCHEDULES_CACHE.lock().unwrap();
    *cache = schedules.clone();
    Ok(schedules)
}

#[tauri::command]
pub async fn delete_schedule(app: AppHandle, id: String) -> Result<(), String> {
    let mut cache = SCHEDULES_CACHE.lock().unwrap();
    cache.retain(|s| s.id != id);
    let schedules = cache.clone();
    drop(cache);
    save_schedules_to_store(&app, &schedules)
}

pub async fn run_scheduler(app: AppHandle) {
    // Load schedules on start
    let initial = load_schedules_from_store(&app);
    {
        let mut cache = SCHEDULES_CACHE.lock().unwrap();
        *cache = initial;
    }

    dbg_log("INFO", "[SCHEDULER] Started");

    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;

        let now = chrono::Local::now();
        let current_hour = now.hour();
        let current_minute = now.minute();

        let schedules = {
            SCHEDULES_CACHE.lock().unwrap().clone()
        };

        for schedule in &schedules {
            if !schedule.enabled {
                continue;
            }

            if schedule.hour != current_hour || schedule.minute != current_minute {
                continue;
            }

            // Check if already ran this minute
            if let Some(ref last_run) = schedule.last_run {
                if let Ok(last) = chrono::DateTime::parse_from_rfc3339(last_run) {
                    let last_local = last.with_timezone(&chrono::Local);
                    if last_local.date_naive() == now.date_naive()
                        && last_local.hour() == current_hour
                        && last_local.minute() == current_minute
                    {
                        continue; // Already ran this minute
                    }
                }
            }

            dbg_log(
                "INFO",
                &format!(
                    "[SCHEDULER] Running schedule: {} ({})",
                    schedule.name, schedule.id
                ),
            );

            // Update last_run
            {
                let mut cache = SCHEDULES_CACHE.lock().unwrap();
                if let Some(s) = cache.iter_mut().find(|s| s.id == schedule.id) {
                    s.last_run = Some(now.to_rfc3339());
                }
                let _ = save_schedules_to_store(&app, &cache);
            }

            // Execute the scheduled sync
            let app_handle = app.clone();
            let sched = schedule.clone();
            tokio::spawn(async move {
                run_scheduled_sync(app_handle, sched).await;
            });
        }
    }
}

use chrono::Timelike;

async fn run_scheduled_sync(app: AppHandle, schedule: ScheduleConfig) {
    if schedule.speed_limit > 0 {
        SPEED_LIMIT.store(schedule.speed_limit as usize, std::sync::atomic::Ordering::Relaxed);
    }

    // Compare folders
    let plan = match crate::sync::compare_folders(
        schedule.deck_ip.clone(),
        schedule.deck_password.clone(),
        schedule.local_dir.clone(),
        schedule.remote_dir.clone(),
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            dbg_log("ERROR", &format!("[SCHEDULER] Compare failed for {}: {}", schedule.name, e));
            notify(&app, &schedule.name, &format!("Sync failed: {}", e));
            return;
        }
    };

    if plan.total_upload_count == 0 {
        dbg_log("INFO", &format!("[SCHEDULER] {} - nothing to sync", schedule.name));
        notify(&app, &schedule.name, "Everything is up to date. No files synced.");
        return;
    }

    // Execute sync
    match crate::sync::execute_sync(
        app.clone(),
        schedule.deck_ip.clone(),
        schedule.deck_password.clone(),
        plan,
        if schedule.speed_limit > 0 { Some(schedule.speed_limit) } else { None },
    )
    .await
    {
        Ok(result) => {
            let msg = format!(
                "Synced {} file{}, {} transferred{}",
                result.success_count,
                if result.success_count != 1 { "s" } else { "" },
                format_bytes(result.bytes_transferred),
                if result.error_count > 0 {
                    format!(", {} failed", result.error_count)
                } else {
                    String::new()
                }
            );
            dbg_log("INFO", &format!("[SCHEDULER] {} - {}", schedule.name, msg));
            notify(&app, &schedule.name, &msg);
        }
        Err(e) => {
            dbg_log("ERROR", &format!("[SCHEDULER] Sync failed for {}: {}", schedule.name, e));
            notify(&app, &schedule.name, &format!("Sync failed: {}", e));
        }
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification()
        .builder()
        .title(format!("Deck Transfer - {}", title))
        .body(body)
        .show();
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

// ── Free trial + one-time lifetime unlock (Mac App Store) ─────────────────
// Two non-consumable in-app purchases:
//   - TRIAL_ID  : a free item. Buying it STARTS the trial; the trial start is its
//                 purchase time, which lives in the user's Apple ID, so deleting
//                 local data or reinstalling cannot reset the trial.
//   - UNLOCK_ID : the paid one-time purchase.
// StoreKit is the source of truth; license.json is only a cache.
//
// FAIL OPEN, ALWAYS: the gate engages only once the store confirms it knows our
// products. While the products do not exist yet, or the App Store cannot be
// reached, the app stays fully usable, so nobody (least of all a paying user) is
// locked out by a missing answer.
//
// Off macOS there are no purchases and no gate: Windows is sold separately.

use serde::Serialize;
use tauri::AppHandle;

#[cfg(target_os = "macos")]
use serde::Deserialize;

/// Trial length. MUST match TRIAL_DAYS in src/licensing.tsx.
#[cfg(target_os = "macos")]
const TRIAL_MS: i64 = 7 * 86_400_000;

// App Store Connect product IDs allow no hyphens, so the bundle ID's hyphen
// (com.deck-transfer.app) becomes an underscore here.
#[cfg(target_os = "macos")]
const UNLOCK_ID: &str = "com.deck_transfer.app.unlock";
#[cfg(target_os = "macos")]
const TRIAL_ID: &str = "com.deck_transfer.app.trial";

#[cfg(target_os = "macos")]
const STORE_UNREACHABLE: &str = "Can't connect to the App Store. Check your internet connection and try again.";

const TRIAL_ENDED: &str = "Your free trial has ended. Buy Deck Transfer to keep using it.";

/// What the frontend gates on. `store_ready` false means "no trustworthy answer":
/// the frontend keeps the app open and ignores `owned` / `trial_start_ms`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    owned: bool,
    trial_start_ms: i64,
    store_ready: bool,
    /// False in builds with no App Store purchases at all (Windows).
    store_build: bool,
}

// ── macOS: the real StoreKit bridge ────────────────────────────────────────

#[cfg(target_os = "macos")]
#[derive(Serialize, Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
struct License {
    owned: bool,
    trial_start_ms: i64, // 0 = trial not started
}

#[cfg(target_os = "macos")]
fn cache_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_local_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("license.json"))
}

#[cfg(target_os = "macos")]
fn read_cache(app: &AppHandle) -> License {
    cache_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn write_cache(app: &AppHandle, lic: &License) {
    if let (Some(p), Ok(json)) = (cache_path(app), serde_json::to_vec(lic)) {
        let _ = std::fs::write(p, json);
    }
}

#[cfg(target_os = "macos")]
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// True only when the App Store answered AND knows the unlock product. StoreKit
/// reports "not owned" for a product that does not exist, so only this explicit
/// check can tell "not bought" apart from "no answer".
#[cfg(target_os = "macos")]
async fn store_ready(app: &AppHandle) -> bool {
    use tauri_plugin_iap::IapExt;
    matches!(
        app.iap().get_products(vec![UNLOCK_ID.to_string()], "inapp".to_string()).await,
        Ok(resp) if resp.products.iter().any(|p| p.product_id == UNLOCK_ID)
    )
}

/// Ask Apple for both products' status. Writes the cache ONLY when Apple actually
/// answered for both; a failed read returns None and leaves the cache untouched,
/// so a store hiccup can never overwrite a paying user's record with "nothing".
#[cfg(target_os = "macos")]
async fn refresh_from_store(app: &AppHandle) -> Option<License> {
    use tauri_plugin_iap::IapExt;
    let unlock = app
        .iap()
        .get_product_status(UNLOCK_ID.to_string(), "inapp".to_string())
        .await
        .ok()?;
    let trial = app
        .iap()
        .get_product_status(TRIAL_ID.to_string(), "inapp".to_string())
        .await
        .ok()?;
    let trial_start_ms = if trial.is_owned {
        trial
            .purchase_time
            .filter(|t| *t > 0)
            .unwrap_or_else(|| read_cache(app).trial_start_ms)
    } else {
        0
    };
    let lic = License { owned: unlock.is_owned, trial_start_ms };
    write_cache(app, &lic);
    Some(lic)
}

// The gate runs before every transfer, folder listing and ROM move, and a ROM
// cleanup can run hundreds of those back to back. One store answer is reused
// for a minute; buying, starting the trial or restoring clears it.
#[cfg(target_os = "macos")]
static ACCESS_MEMO: std::sync::Mutex<Option<(std::time::Instant, bool)>> = std::sync::Mutex::new(None);

#[cfg(target_os = "macos")]
fn forget_access() {
    if let Ok(mut memo) = ACCESS_MEMO.lock() {
        *memo = None;
    }
}

/// True when the user may use the app. Blocked ONLY once a STARTED trial has run
/// out and nothing is owned. The pre-trial state is allowed (the start screen
/// covers the window), and every missing store answer fails open.
#[cfg(target_os = "macos")]
pub async fn has_access(app: &AppHandle) -> bool {
    if let Ok(memo) = ACCESS_MEMO.lock() {
        if let Some((at, ok)) = *memo {
            if at.elapsed() < std::time::Duration::from_secs(60) {
                return ok;
            }
        }
    }
    let ok = if !store_ready(app).await {
        true // products not live yet, or the store is unreachable
    } else {
        match refresh_from_store(app).await {
            None => true,
            Some(lic) if lic.owned => true,
            Some(lic) => !(lic.trial_start_ms > 0 && now_ms() >= lic.trial_start_ms + TRIAL_MS),
        }
    };
    if let Ok(mut memo) = ACCESS_MEMO.lock() {
        *memo = Some((std::time::Instant::now(), ok));
    }
    ok
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn iap_status(app: AppHandle) -> LicenseStatus {
    if store_ready(&app).await {
        if let Some(l) = refresh_from_store(&app).await {
            return LicenseStatus { owned: l.owned, trial_start_ms: l.trial_start_ms, store_ready: true, store_build: true };
        }
    }
    let c = read_cache(&app);
    LicenseStatus { owned: c.owned, trial_start_ms: c.trial_start_ms, store_ready: false, store_build: true }
}

/// The unlock's price, formatted by the store in the user's own currency.
/// Empty when unknown; the price is never hardcoded.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn iap_price(app: AppHandle) -> String {
    use tauri_plugin_iap::IapExt;
    app.iap()
        .get_products(vec![UNLOCK_ID.to_string()], "inapp".to_string())
        .await
        .ok()
        .and_then(|resp| resp.products.into_iter().find(|p| p.product_id == UNLOCK_ID))
        .and_then(|p| p.formatted_price)
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn iap_start_trial(app: AppHandle) -> Result<i64, String> {
    use tauri_plugin_iap::{IapExt, PurchaseRequest};
    let purchase = app
        .iap()
        .purchase(PurchaseRequest {
            product_id: TRIAL_ID.to_string(),
            product_type: "inapp".to_string(),
            options: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    forget_access();
    // Prefer Apple's recorded status: on a reinstall it carries the ORIGINAL start.
    if let Some(l) = refresh_from_store(&app).await {
        if l.trial_start_ms > 0 {
            return Ok(l.trial_start_ms);
        }
    }
    let mut c = read_cache(&app);
    c.trial_start_ms = purchase.purchase_time;
    write_cache(&app, &c);
    Ok(c.trial_start_ms)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn iap_buy(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_iap::{IapExt, PurchaseRequest};
    app.iap()
        .purchase(PurchaseRequest {
            product_id: UNLOCK_ID.to_string(),
            product_type: "inapp".to_string(),
            options: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    forget_access();
    match refresh_from_store(&app).await {
        Some(l) => Ok(l.owned),
        None => {
            // The purchase itself was confirmed by StoreKit above.
            let mut c = read_cache(&app);
            c.owned = true;
            write_cache(&app, &c);
            Ok(true)
        }
    }
}

/// Success means Apple confirmed the result. Ownership and the trial start both
/// come back from Apple, so restoring can never hand out a fresh trial and an
/// edited license.json can never make "owned" true.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn iap_restore(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_iap::IapExt;
    app.iap()
        .restore_purchases("inapp".to_string())
        .await
        .map_err(|e| e.to_string())?;
    forget_access();
    refresh_from_store(&app)
        .await
        .ok_or_else(|| STORE_UNREACHABLE.to_string())?;
    Ok(())
}

// ── Everywhere else: inert, and never gated ────────────────────────────────

#[cfg(not(target_os = "macos"))]
const NOT_AVAILABLE: &str = "Purchases are only available in the Mac App Store build.";

#[cfg(not(target_os = "macos"))]
pub async fn has_access(_app: &AppHandle) -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn iap_status(_app: AppHandle) -> LicenseStatus {
    LicenseStatus { owned: true, trial_start_ms: 0, store_ready: false, store_build: false }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn iap_price(_app: AppHandle) -> String {
    String::new()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn iap_start_trial(_app: AppHandle) -> Result<i64, String> {
    Err(NOT_AVAILABLE.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn iap_buy(_app: AppHandle) -> Result<bool, String> {
    Err(NOT_AVAILABLE.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn iap_restore(_app: AppHandle) -> Result<(), String> {
    Err(NOT_AVAILABLE.to_string())
}

// ── The backend gate ───────────────────────────────────────────────────────

/// Called at the top of every command that does the app's real work: finding
/// the Deck, browsing and changing its folders, transfers, syncs and the ROM
/// tools. The purchase page is only a page overlay; this is what makes the lock
/// real. Never called from the purchase commands, settings, history, or anything
/// the purchase page itself needs.
pub async fn require_access(app: &AppHandle) -> Result<(), String> {
    if has_access(app).await {
        Ok(())
    } else {
        Err(TRIAL_ENDED.to_string())
    }
}

import { invoke } from "@tauri-apps/api/core";

const CHECK_PRO_URL = "https://jhuxxolbcrjerztwqyap.supabase.co/functions/v1/deck-transfer-check-pro";

interface ProStatus {
  valid: boolean;
  licenseKey: string | null;
  email: string | null;
  activatedAt: string | null;
}

async function loadCached(): Promise<ProStatus | null> {
  try {
    const json = await invoke<string>("load_pro_status");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function saveCached(status: ProStatus): Promise<void> {
  try {
    await invoke("save_pro_status", { json: JSON.stringify(status) });
  } catch {}
}

// Validate a license key against the server
export async function validateLicenseKey(key: string): Promise<{ valid: boolean; email?: string; error?: string }> {
  try {
    const response = await fetch(`${CHECK_PRO_URL}?key=${encodeURIComponent(key.toUpperCase().trim())}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();

    if (data.valid) {
      await saveCached({
        valid: true,
        licenseKey: key.toUpperCase().trim(),
        email: data.email,
        activatedAt: new Date().toISOString(),
      });
    }

    return { valid: data.valid, email: data.email, error: data.error };
  } catch {
    // If network fails, check cache
    const cached = await loadCached();
    if (cached && cached.valid && cached.licenseKey === key.toUpperCase().trim()) {
      return { valid: true, email: cached.email || undefined };
    }
    return { valid: false, error: "Could not connect to server. Check your internet connection." };
  }
}

// Get cached Pro status (for app startup)
export async function getCachedProStatus(): Promise<ProStatus | null> {
  return loadCached();
}

// Re-validate cached key against server (doesn't increment activations)
export async function revalidateCachedKey(): Promise<boolean> {
  const cached = await loadCached();
  if (!cached?.valid || !cached?.licenseKey) return false;
  try {
    const response = await fetch(
      `${CHECK_PRO_URL}?key=${encodeURIComponent(cached.licenseKey)}&check_only=true`
    );
    if (!response.ok) return true; // Network error, trust cache
    const data = await response.json();
    if (!data.valid) {
      // Key deactivated on server - clear local cache
      await saveCached({ valid: false, licenseKey: null, email: null, activatedAt: null });
      return false;
    }
    return true;
  } catch {
    return true; // Offline, trust cache
  }
}

// Clear Pro status (deactivate)
export async function clearProStatus(): Promise<void> {
  await saveCached({ valid: false, licenseKey: null, email: null, activatedAt: null });
}

// Get stored license key
export async function getStoredLicenseKey(): Promise<string | null> {
  const cached = await loadCached();
  return cached?.licenseKey || null;
}


// ══════════════════════════════════════════════════════════════
// FREE TRIAL + LIFETIME UNLOCK (Mac App Store build only)
// ══════════════════════════════════════════════════════════════
// The Rust side (src-tauri/src/licensing.rs) talks to StoreKit and enforces the
// same rule on every scan, transfer, sync and ROM tool. Everything here fails
// OPEN: until the store confirms it knows the products, the app stays fully
// usable. Open means usable, never "owned": the trial bar's Buy button stays up
// until a purchase is confirmed, so the purchase can always be found.
import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_MAC } from "./utils";

const TRIAL_DAYS = 7; // MUST match TRIAL_MS in src-tauri/src/licensing.rs
const DAY_MS = 86400000;
// Preview the screens without the store: start | trial | expired | owned,
// optionally ":noprice" (e.g. "trial:noprice").
const DEV_LICENSE_KEY = "decktransfer_dev_license";
const CANCEL_NOTE = "Purchase canceled.";
const STORE_UNREACHABLE = "Can't connect to the App Store. Check your internet connection and try again.";
const NOT_STORE_BUILD = "Purchases only work in the App Store version of Deck Transfer.";

const START_LINE = "Sends files from your Mac to your Steam Deck, by cable or Wi-Fi.";
const KEEP_LINE = "Buy Deck Transfer to keep sending files and managing your Deck.";

interface LicenseStatus {
  owned: boolean;
  trialStartMs: number;
  storeReady: boolean;
  storeBuild: boolean;
}

interface Message {
  text: string;
  note: boolean;
}

// "Purchase cancelled by user" on macOS: pressing Cancel is not a failure.
function isUserCancel(e: unknown) {
  return /cancel/i.test(String(e || ""));
}

function friendlyStoreError(e: unknown) {
  const s = String(e || "");
  if (/only available in the Mac App Store|\.app bundle/i.test(s)) return NOT_STORE_BUILD;
  return STORE_UNREACHABLE;
}

export function useLicense() {
  const [storeBuild, setStoreBuild] = useState(false);
  // storeLive: the store answered about our products, so the start page, the
  // trial bar's countdown and the lock can be trusted.
  const [storeLive, setStoreLive] = useState(false);
  const [owned, setOwned] = useState(true);
  const [trialStartMs, setTrialStartMs] = useState(0);
  const [price, setPrice] = useState("");
  const [offerOpen, setOfferOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // Places with no message line (the trial bar, Settings) answer in an alert.
  const [alertText, setAlertText] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const devPreview = useRef<string | null>(null);

  // Read the store's answer (asking again when none is passed in). Only a real
  // answer (storeReady) is trusted for owned and the trial start.
  const refreshStore = useCallback(async (given?: LicenseStatus | null) => {
    let status = given;
    if (status === undefined) {
      status = null;
      try {
        status = await invoke<LicenseStatus>("iap_status");
      } catch {}
    }
    const live = !!(status && status.storeReady);
    setStoreLive(live);
    if (live && status) {
      setOwned(!!status.owned);
      setTrialStartMs(Number(status.trialStartMs) || 0);
    }
    let p = "";
    try {
      p = (await invoke<string>("iap_price")) || "";
    } catch {}
    if (p) setPrice(p);
  }, []);

  useEffect(() => {
    (async () => {
      let dev: string | null = null;
      try {
        dev = localStorage.getItem(DEV_LICENSE_KEY);
      } catch {}
      const [devState, devOpt] = String(dev || "").split(":");
      if (["start", "trial", "expired", "owned"].includes(devState)) {
        devPreview.current = devState;
        setStoreBuild(true);
        setStoreLive(true);
        setOwned(devState === "owned");
        setTrialStartMs(
          devState === "trial" ? Date.now() - 2 * DAY_MS : devState === "expired" ? Date.now() - 8 * DAY_MS : 0
        );
        setPrice(devOpt === "noprice" ? "" : "6,99 €");
        return;
      }
      if (!IS_MAC) return; // Windows: no purchases
      let status: LicenseStatus | null = null;
      try {
        status = await invoke<LicenseStatus>("iap_status");
      } catch {}
      if (status && status.storeBuild === false) return;
      // No store answer: usable, but NOT owned, so the Buy button stays visible.
      setStoreBuild(true);
      setOwned(false);
      await refreshStore(status);
    })();
  }, [refreshStore]);

  // Keep the countdown current and lock the app the moment a trial runs out.
  useEffect(() => {
    if (!storeBuild || owned || trialStartMs <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, [storeBuild, owned, trialStartMs]);

  let needsTrialStart = false;
  let trialActive = false;
  let hasAccess = true;
  if (!storeBuild || owned || !storeLive) {
    hasAccess = true; // no store answer fails open: usable, still not owned
  } else if (trialStartMs > 0) {
    trialActive = trialStartMs + TRIAL_DAYS * DAY_MS - now > 0;
    hasAccess = trialActive;
  } else {
    needsTrialStart = true;
    hasAccess = false;
  }
  const startUp = needsTrialStart;
  const paywallUp = !needsTrialStart && !hasAccess;
  const offerUp = !owned && !startUp && !paywallUp && offerOpen;
  const pageUp = startUp || paywallUp || offerUp;
  const barShown = storeBuild && !owned && !pageUp;
  const daysLeft = Math.max(1, Math.ceil((trialStartMs + TRIAL_DAYS * DAY_MS - now) / DAY_MS));

  const startTrial = useCallback(async () => {
    setMessage(null);
    if (devPreview.current) {
      setTrialStartMs(Date.now());
      setNow(Date.now());
      return;
    }
    setBusy(true);
    try {
      const ms = Number(await invoke<number>("iap_start_trial")) || Date.now();
      setTrialStartMs(ms);
      setNow(Date.now());
    } catch (e) {
      setMessage(isUserCancel(e) ? { text: CANCEL_NOTE, note: true } : { text: friendlyStoreError(e), note: false });
    } finally {
      setBusy(false);
    }
  }, []);

  // inline: answer in the purchase page's message line; otherwise in an alert.
  const buy = useCallback(async (inline: boolean) => {
    const say = (text: string, note: boolean) => (inline ? setMessage({ text, note }) : setAlertText(text));
    setMessage(null);
    if (devPreview.current) {
      setOwned(true);
      return;
    }
    setBusy(true);
    try {
      if (await invoke<boolean>("iap_buy")) setOwned(true);
    } catch (e) {
      if (isUserCancel(e)) say(CANCEL_NOTE, true);
      else say(friendlyStoreError(e), false);
    } finally {
      setBusy(false);
    }
  }, []);

  const restore = useCallback(
    async (inline: boolean) => {
      const say = (text: string, note: boolean) => (inline ? setMessage({ text, note }) : setAlertText(text));
      setMessage(null);
      if (devPreview.current) {
        say(owned ? "Purchase restored." : "No purchase found for this Apple ID.", true);
        return;
      }
      setBusy(true);
      try {
        await invoke("iap_restore");
        const st = await invoke<LicenseStatus>("iap_status");
        // No store answer means iap_status returned the editable local cache:
        // never read "owned" from it, and never claim a restore.
        if (!st || !st.storeReady) {
          say(STORE_UNREACHABLE, false);
          return;
        }
        setStoreLive(true);
        setOwned(!!st.owned);
        setTrialStartMs(Number(st.trialStartMs) || 0);
        say(st.owned ? "Purchase restored." : "No purchase found for this Apple ID.", true);
      } catch (e) {
        if (isUserCancel(e)) say(CANCEL_NOTE, true);
        else say(friendlyStoreError(e), false);
      } finally {
        setBusy(false);
      }
    },
    [owned]
  );

  // The offer: opened from the trial bar when the store has not answered. It
  // asks the store again first, so a price that did not load at launch gets
  // another chance. The cross and Esc close it.
  const openOffer = useCallback(async () => {
    setMessage(null);
    setOfferOpen(true);
    if (!devPreview.current) await refreshStore();
  }, [refreshStore]);

  const closeOffer = useCallback(() => {
    setMessage(null);
    setOfferOpen(false);
  }, []);

  const dismissAlert = useCallback(() => setAlertText(null), []);

  // During the trial the bar's button buys; with the store silent it opens the offer.
  const barClick = useCallback(() => {
    if (storeLive && trialActive) buy(false);
    else openOffer();
  }, [storeLive, trialActive, buy, openOffer]);

  return {
    storeBuild,
    storeLive,
    owned,
    price,
    busy,
    message,
    alertText,
    dismissAlert,
    trialActive,
    daysLeft,
    startUp,
    paywallUp,
    offerUp,
    pageUp,
    barShown,
    startTrial,
    buy,
    restore,
    closeOffer,
    barClick,
  };
}

export type License = ReturnType<typeof useLicense>;

// The one place to buy while the app is open and not bought: text on the
// left, the button on the right at its label's width.
export function TrialBar({ lic }: { lic: License }) {
  if (!lic.barShown) return null;
  const countdown = lic.storeLive && lic.trialActive;
  const text = countdown
    ? `${lic.daysLeft} ${lic.daysLeft === 1 ? "day" : "days"} left in your free trial`
    : "Deck Transfer is a one-time purchase";
  const label = countdown ? (lic.price ? `Buy for ${lic.price}` : "Buy") : "Buy Deck Transfer";
  return (
    <div className="trial-bar">
      <span className="trial-bar-text">{text}</span>
      <button className="trial-bar-btn" onClick={lic.barClick} disabled={lic.busy}>
        {label}
      </button>
    </div>
  );
}

// The start page, the paywall and the offer: one page covering the window, in
// two columns (app-related/apple/paywall_layout.txt, section 6).
export function BuyPage({ lic }: { lic: License }) {
  const { offerUp, closeOffer } = lic;

  // Esc closes the offer, never the start page or the paywall.
  useEffect(() => {
    if (!offerUp) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeOffer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [offerUp, closeOffer]);

  if (!lic.pageUp) return null;
  const { startUp, paywallUp, price } = lic;
  const title = startUp ? "Deck Transfer" : paywallUp ? "Your free trial has ended" : "Buy Deck Transfer";
  const line = startUp ? START_LINE : KEEP_LINE;
  const main = startUp ? "Start Free Trial" : price ? `Buy for ${price}` : "Buy Deck Transfer";

  return (
    <div className="buy-page" role="dialog" aria-modal="true">
      {offerUp && (
        <button className="buy-page-close" onClick={closeOffer} title="Not Now" aria-label="Not Now">
          ✕
        </button>
      )}
      <div className="buy-mac">
        <div className="buy-mac-left">
          <div className="buy-page-icon">
            <svg viewBox="0 0 88 88" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="10" y="28" width="26" height="19" rx="2.5" />
              <path d="M23 47v5M17 52h12" />
              <path d="M36 40h5M47 40h5" />
              <rect x="41" y="36.5" width="6" height="7" rx="1" fill="#fff" />
              <rect x="52" y="31" width="27" height="18" rx="9" />
              <rect x="60.5" y="35" width="10" height="10" rx="1.5" />
              <path d="M55.5 40h3.4M57.2 38.3v3.4" strokeWidth="1.8" />
              <circle cx="75" cy="37.8" r="1.1" fill="#fff" stroke="none" />
              <circle cx="75" cy="42.2" r="1.1" fill="#fff" stroke="none" />
            </svg>
          </div>
          <h2 className="buy-page-title">{title}</h2>
          <p className="buy-page-line">{price ? line : `${line} You pay once.`}</p>
          <ul className="buy-page-benefits">
            <li><span className="buy-page-tick">✓</span>Send files to your Deck by cable or Wi-Fi</li>
            <li><span className="buy-page-tick">✓</span>Browse and manage the Deck's folders</li>
            <li><span className="buy-page-tick">✓</span>Sync folders, on demand or on a schedule</li>
            <li><span className="buy-page-tick">✓</span>Move, fix and clean up your ROMs</li>
          </ul>
        </div>
        <div className="buy-mac-right">
          {price && (
            <div className="buy-page-price">
              <span className="buy-page-plan">Lifetime</span>
              <strong>{price}</strong>
              <span className="buy-page-paid">Paid once. Not a subscription.</span>
            </div>
          )}
          {startUp && (
            <ol className="buy-page-steps">
              <li><strong>Today</strong><span>Every feature, free for {TRIAL_DAYS} days.</span></li>
              <li><strong>Day {TRIAL_DAYS}</strong><span>The free trial ends. Nothing is charged.</span></li>
              <li><strong>After that</strong><span>Transfers, syncs and ROM tools stop until you buy Deck Transfer.</span></li>
            </ol>
          )}
          <p className={`buy-page-msg ${lic.message?.note ? "note" : ""}`} aria-live="polite">
            {lic.message?.text || ""}
          </p>
          <button
            className="buy-page-main"
            onClick={() => (startUp ? lic.startTrial() : lic.buy(true))}
            disabled={lic.busy}
          >
            {main}
          </button>
          {startUp && <p className="buy-page-small">Nothing is charged automatically.</p>}
          <button className="buy-page-restore" onClick={() => lic.restore(true)} disabled={lic.busy}>
            Restore Purchases
          </button>
        </div>
      </div>
    </div>
  );
}

// The answer to a Buy or Restore pressed where there is no message line.
export function LicenseAlert({ lic }: { lic: License }) {
  const { alertText, dismissAlert } = lic;
  useEffect(() => {
    if (!alertText) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissAlert();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [alertText, dismissAlert]);

  if (!alertText) return null;
  return (
    <div className="dialog-overlay license-alert-overlay" onClick={lic.dismissAlert}>
      <div className="dialog license-alert" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true">
        <div className="dialog-body">{lic.alertText}</div>
        <div className="license-alert-actions">
          <button className="dialog-btn dialog-btn-primary" onClick={lic.dismissAlert} autoFocus>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

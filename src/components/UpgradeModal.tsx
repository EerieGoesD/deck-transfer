import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { validateLicenseKey } from "../services/premium";

const STRIPE_LINK = "https://buy.stripe.com/28EeVe83G77AbeS8X2cQU01";

interface UpgradeModalProps {
  onClose: () => void;
  onActivated: (email: string) => void;
}

export default function UpgradeModal({ onClose, onActivated }: UpgradeModalProps) {
  const [licenseKey, setLicenseKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [activatedKey, setActivatedKey] = useState("");
  const [copied, setCopied] = useState(false);

  const handleActivate = useCallback(async () => {
    if (!licenseKey.trim()) return;
    setValidating(true);
    setError(null);
    try {
      const result = await validateLicenseKey(licenseKey.trim());
      if (result.valid) {
        setActivatedKey(licenseKey.trim().toUpperCase());
        setSuccess(true);
        onActivated(result.email || "");
      } else {
        setError(result.error || "Invalid license key.");
      }
    } catch {
      setError("Could not validate license key. Please try again.");
    } finally {
      setValidating(false);
    }
  }, [licenseKey, onActivated]);

  const handleBuy = useCallback(() => {
    invoke("open_url", { url: STRIPE_LINK }).catch(() => {
      window.open(STRIPE_LINK, "_blank");
    });
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(activatedKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [activatedKey]);

  const handleKeyInput = (value: string) => {
    const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    const parts = clean.match(/.{1,4}/g) || [];
    setLicenseKey(parts.join("-"));
  };

  if (success) {
    return (
      <div className="dialog-overlay" onClick={onClose}>
        <div className="upgrade-modal" onClick={(e) => e.stopPropagation()}>
          <div className="upgrade-header">
            <h2>Pro Activated!</h2>
            <button className="settings-close" onClick={onClose}>x</button>
          </div>

          <div className="upgrade-success-icon">&#10003;</div>

          <p className="upgrade-success-text">
            Deck Transfer Pro is now active. All Pro features are unlocked.
          </p>

          <div className="upgrade-key-display">
            <span className="upgrade-key-label">Your license key</span>
            <div className="upgrade-key-box">
              <code>{activatedKey}</code>
              <button className="upgrade-copy-btn" onClick={handleCopy}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          <div className="upgrade-key-note">
            Save this key somewhere safe. You'll need it to reactivate if you reinstall the app or switch to a different PC. This key can be activated on up to 3 devices.
          </div>

          <button className="upgrade-subscribe-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="upgrade-modal" onClick={(e) => e.stopPropagation()}>
        <div className="upgrade-header">
          <h2>Deck Transfer Pro</h2>
          <button className="settings-close" onClick={onClose}>x</button>
        </div>

        <div className="upgrade-features">
          <div className="upgrade-feature">
            <span className="upgrade-feature-icon">&#128203;</span>
            <div>
              <div className="upgrade-feature-name">Transfer History</div>
              <div className="upgrade-feature-desc">View past transfers and re-send with one click</div>
            </div>
          </div>
          <div className="upgrade-feature">
            <span className="upgrade-feature-icon">&#128337;</span>
            <div>
              <div className="upgrade-feature-name">Transfer Scheduling</div>
              <div className="upgrade-feature-desc">Schedule transfers and syncs to run at specific times</div>
            </div>
          </div>
          <div className="upgrade-feature">
            <span className="upgrade-feature-icon">&#128276;</span>
            <div>
              <div className="upgrade-feature-name">Desktop Notifications</div>
              <div className="upgrade-feature-desc">Get notified when transfers and scheduled syncs complete</div>
            </div>
          </div>
        </div>

        <div className="upgrade-price">
          EUR 3.00 / month - Cancel anytime
        </div>

        <button className="upgrade-subscribe-btn" onClick={handleBuy}>
          Buy Pro
        </button>

        <span className="upgrade-buy-hint">
          After payment, you'll receive your license key via email.
        </span>

        <div className="upgrade-divider">
          <span>Have a license key?</span>
        </div>

        <div className="upgrade-email-section">
          <input
            className="upgrade-email-input upgrade-key-input"
            type="text"
            value={licenseKey}
            onChange={(e) => handleKeyInput(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            onKeyDown={(e) => {
              if (e.key === "Enter" && licenseKey.trim()) handleActivate();
            }}
          />
        </div>

        {error && <div className="upgrade-error">{error}</div>}

        <button
          className="upgrade-activate-btn"
          onClick={handleActivate}
          disabled={licenseKey.replace(/-/g, "").length < 16 || validating}
        >
          {validating ? "Validating..." : "Activate"}
        </button>
      </div>
    </div>
  );
}

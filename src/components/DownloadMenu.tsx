import { useEffect } from "react";
import { COMPUTER } from "../utils";

interface Props {
  x: number;
  y: number;
  /** Why there is nothing to download, shown instead of the action. */
  disabledReason?: string;
  onDownload: () => void;
  onClose: () => void;
}

// The right-click menu on a finder result: one action, Download to Mac / PC.
// Closes on any click elsewhere, a right-click elsewhere, a scroll, Esc, or when
// the window loses focus.
export default function DownloadMenu({ x, y, disabledReason, onDownload, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", onClose);
    window.addEventListener("contextmenu", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClose);
      window.removeEventListener("contextmenu", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="ctx-menu" style={{ top: y, left: x }} onClick={(e) => e.stopPropagation()}>
      <button
        className="ctx-menu-item"
        disabled={!!disabledReason}
        title={disabledReason}
        onClick={() => {
          onClose();
          onDownload();
        }}
      >
        Download to {COMPUTER}…
      </button>
    </div>
  );
}

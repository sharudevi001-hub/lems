import React, { useEffect, useId, useRef, useState } from "react";

const QR_SCANNER_CDN = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";

function loadQrScannerLibrary() {
  if (typeof window !== "undefined" && window.Html5Qrcode) return Promise.resolve(window.Html5Qrcode);
  if (typeof document === "undefined") return Promise.reject(new Error("Camera scanning is unavailable."));
  return new Promise((resolve, reject) => {
    let script = document.querySelector('script[data-lems-qr-scanner="true"]');
    if (script) {
      if (window.Html5Qrcode) return resolve(window.Html5Qrcode);
      script.addEventListener("load", () => window.Html5Qrcode ? resolve(window.Html5Qrcode) : reject(new Error("QR scanner library did not load.")), { once: true });
      script.addEventListener("error", () => reject(new Error("Could not load the camera scanner. Use manual entry below.")), { once: true });
      return;
    }
    script = document.createElement("script");
    script.src = QR_SCANNER_CDN;
    script.async = true;
    script.dataset.lemsQrScanner = "true";
    script.onload = () => window.Html5Qrcode ? resolve(window.Html5Qrcode) : reject(new Error("QR scanner library did not load."));
    script.onerror = () => reject(new Error("Could not load the camera scanner. Use manual entry below."));
    document.head.appendChild(script);
  });
}

/** Cross-browser QR camera scanner with a manual-entry fallback. */
export default function CameraScanner({ onDetected, label = "Scan QR / barcode", placeholder = "Paste or type scanned code" }) {
  const videoRegionId = "lems-qr-" + useId().replace(/:/g, "");
  const scannerRef = useRef(null);
  const onDetectedRef = useRef(onDetected);
  const detectedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState("");
  const [error, setError] = useState("");
  const [cameraBusy, setCameraBusy] = useState(false);

  useEffect(() => { onDetectedRef.current = onDetected; }, [onDetected]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let scanner = null;
    detectedRef.current = false;
    setError("");
    setCameraBusy(true);

    async function start() {
      try {
        const Html5Qrcode = await loadQrScannerLibrary();
        if (cancelled) return;
        scanner = new Html5Qrcode(videoRegionId, { verbose: false });
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 12, qrbox: { width: 240, height: 240 }, aspectRatio: 1.0, disableFlip: false },
          decodedText => {
            const value = String(decodedText || "").trim();
            if (!value || detectedRef.current) return;
            detectedRef.current = true;
            setOpen(false);
            onDetectedRef.current(value);
            scanner.stop().catch(() => {}).finally(() => {
              try { scanner.clear(); } catch {}
              if (scannerRef.current === scanner) scannerRef.current = null;
            });
          },
          () => {}
        );
      } catch (e) {
        if (!cancelled) {
          setError(e?.name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access or use manual entry below."
            : (e?.message || "Camera could not start. Use manual entry below."));
        }
      } finally {
        if (!cancelled) setCameraBusy(false);
      }
    }
    start();

    return () => {
      cancelled = true;
      const active = scannerRef.current || scanner;
      scannerRef.current = null;
      if (active) {
        active.stop().catch(() => {}).finally(() => {
          try { active.clear(); } catch {}
        });
      }
    };
  }, [open, videoRegionId]);

  function close() {
    setOpen(false);
    const active = scannerRef.current;
    scannerRef.current = null;
    if (active) active.stop().catch(() => {}).finally(() => { try { active.clear(); } catch {} });
  }

  function submit(e) {
    e.preventDefault();
    const value = manual.trim();
    if (value) {
      onDetectedRef.current(value);
      setManual("");
    }
  }

  return <section className="stack" style={{ gap: 8 }}>
    <div className="actions">
      <button className="button button--secondary" type="button" onClick={() => { setError(""); setOpen(v => !v); }}>{open ? "Close camera" : "Use phone camera"}</button>
      {cameraBusy && <span className="muted">Starting camera…</span>}
    </div>
    {open && <div className="stack" style={{ gap: 8 }}>
      <div id={videoRegionId} style={{ width: "100%", maxWidth: 420, overflow: "hidden", borderRadius: 14, background: "#172235" }} aria-label={label}/>
      <button className="button button--secondary" type="button" onClick={close}>Stop camera</button>
    </div>}
    {error && <p className="muted" role="status">{error}</p>}
    <form className="form-inline" onSubmit={submit}>
      <label className="field" style={{ flex: 1 }}><span>{label} — manual fallback</span><input className="input" value={manual} onChange={e => setManual(e.target.value)} placeholder={placeholder} autoComplete="off" /></label>
      <button className="button button--primary" type="submit" disabled={!manual.trim()}>Submit code</button>
    </form>
  </section>;
}

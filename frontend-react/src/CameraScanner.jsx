import React, { useEffect, useId, useRef, useState } from "react";

const QR_SCANNER_URLS = [
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
  "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js"
];

function loadQrScannerLibrary() {
  if (typeof window !== "undefined" && window.Html5Qrcode) return Promise.resolve(window.Html5Qrcode);
  if (typeof document === "undefined") return Promise.reject(new Error("Camera scanning is unavailable."));
  return new Promise((resolve, reject) => {
    let script = document.querySelector('script[data-lems-qr-scanner="true"]');
    if (script?.dataset.loaded === "true" && window.Html5Qrcode) return resolve(window.Html5Qrcode);
    if (script?.dataset.failed === "true") script.remove();
    script = document.querySelector('script[data-lems-qr-scanner="true"]');
    if (script) {
      script.addEventListener("load", () => window.Html5Qrcode ? resolve(window.Html5Qrcode) : reject(new Error("QR scanner library did not initialize.")), { once: true });
      script.addEventListener("error", () => reject(new Error("QR scanner library could not load. Check your internet connection.")), { once: true });
      return;
    }

    let sourceIndex = 0;
    const tryNextSource = () => {
      if (sourceIndex >= QR_SCANNER_URLS.length) {
        script.dataset.failed = "true";
        reject(new Error("QR scanner library could not load. Check your internet connection and try again."));
        return;
      }
      const current = document.createElement("script");
      current.src = QR_SCANNER_URLS[sourceIndex++];
      current.async = true;
      current.dataset.lemsQrScanner = "true";
      current.onload = () => {
        current.dataset.loaded = "true";
        if (window.Html5Qrcode) resolve(window.Html5Qrcode);
        else { current.remove(); tryNextSource(); }
      };
      current.onerror = () => { current.remove(); tryNextSource(); };
      script = current;
      document.head.appendChild(current);
    };
    tryNextSource();
  });
}

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

        // Prefer the rear phone camera, but allow a laptop/webcam or another available camera.
        let cameraConfig = { facingMode: "environment" };
        try {
          const cameras = await Html5Qrcode.getCameras();
          if (cancelled) return;
          if (cameras?.length) {
            const rearCamera = cameras.find(camera => /back|rear|environment|trás|trasera|arrière|後|背面/i.test(camera.label || ""));
            cameraConfig = { deviceId: { exact: (rearCamera || cameras[0]).id } };
          }
        } catch {
          // Let html5-qrcode request the environment-facing camera directly if enumeration is blocked.
        }
        if (cancelled) return;
        await scanner.start(
          cameraConfig,
          { fps: 10, qrbox: (viewWidth, viewHeight) => {
              const side = Math.max(160, Math.min(260, Math.floor(Math.min(viewWidth, viewHeight) * 0.72)));
              return { width: side, height: side };
            }, aspectRatio: 1.0, disableFlip: false },
          decodedText => {
            const value = String(decodedText || "").trim();
            if (!value || detectedRef.current) return;
            detectedRef.current = true;
            onDetectedRef.current(value);
            setOpen(false);
          },
          () => {}
        );
      } catch (e) {
        if (!cancelled) {
          const message = e?.message || "";
          setError(/permission|notallowed|denied/i.test(message)
            ? "Camera permission denied. Allow camera access in your browser settings, then press Use phone camera again."
            : /secure|https|origin/i.test(message)
              ? "Camera needs a secure HTTPS page. Open the LEMS website using its https:// address."
              : "Could not start the camera. Check browser camera permission, close other apps using the camera, and try again. " + message);
        }
        if (scanner) {
          try { await scanner.stop(); } catch {}
          try { scanner.clear(); } catch {}
          if (scannerRef.current === scanner) scannerRef.current = null;
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
      <div id={videoRegionId} style={{ width: "100%", maxWidth: 420, minHeight: 260, overflow: "hidden", borderRadius: 14, background: "#172235" }} aria-label={label} />
      <button className="button button--secondary" type="button" onClick={close}>Stop camera</button>
    </div>}
    {error && <p className="muted" role="status">{error}</p>}
    <form className="form-inline" onSubmit={submit}>
      <label className="field" style={{ flex: 1 }}><span>{label} — manual fallback</span><input className="input" value={manual} onChange={e => setManual(e.target.value)} placeholder={placeholder} autoComplete="off" /></label>
      <button className="button button--primary" type="submit" disabled={!manual.trim()}>Submit code</button>
    </form>
  </section>;
}

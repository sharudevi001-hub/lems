import React, { useEffect, useRef, useState } from "react";

/** Uses the browser's native BarcodeDetector where available; manual entry is always available. */
export default function CameraScanner({ onDetected, label = "Scan QR / barcode", placeholder = "Paste or type scanned code" }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState("");
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "BarcodeDetector" in window);
    return () => streamRef.current?.getTracks().forEach(track => track.stop());
  }, []);

  useEffect(() => {
    if (!open || !supported) return undefined;
    let cancelled = false;
    let frame = 0;
    let detector;
    async function start() {
      try {
        detector = new window.BarcodeDetector({ formats: ["qr_code", "code_128", "ean_13", "ean_8", "upc_a"] });
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        const scan = async () => {
          if (cancelled || !videoRef.current || videoRef.current.readyState < 2) { if (!cancelled) frame = requestAnimationFrame(scan); return; }
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes?.length && codes[0].rawValue) {
              const value = codes[0].rawValue.trim();
              setOpen(false);
              streamRef.current?.getTracks().forEach(track => track.stop());
              streamRef.current = null;
              onDetected(value);
              return;
            }
          } catch { /* Camera frames can fail transiently while focus adjusts. */ }
          if (!cancelled) frame = requestAnimationFrame(scan);
        };
        frame = requestAnimationFrame(scan);
      } catch (e) {
        setError(e?.name === "NotAllowedError" ? "Camera permission was denied. Use manual entry below." : "Camera scanner unavailable on this browser. Use manual entry below.");
      }
    }
    start();
    return () => { cancelled = true; cancelAnimationFrame(frame); streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null; };
  }, [open, supported, onDetected]);

  function close() { setOpen(false); streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null; }
  function submit(e) { e.preventDefault(); const value = manual.trim(); if (value) { onDetected(value); setManual(""); } }

  return <section className="stack" style={{ gap: 8 }}>
    <div className="actions">
      <button className="button button--secondary" type="button" onClick={() => { setError(""); setOpen(v => !v); }}>{open ? "Close camera" : "Use phone camera"}</button>
      {!supported && <span className="muted">Native camera scanning needs a supported mobile browser; manual entry is available.</span>}
    </div>
    {open && <div className="stack" style={{ gap: 8 }}>
      {supported ? <video ref={videoRef} playsInline muted style={{ width: "100%", maxWidth: 420, borderRadius: 14, background: "#172235" }} aria-label={label}/> : <p className="muted">Camera QR detection is not supported in this browser.</p>}
      <button className="button button--secondary" type="button" onClick={close}>Stop camera</button>
    </div>}
    {error && <p className="muted" role="status">{error}</p>}
    <form className="form-inline" onSubmit={submit}>
      <label className="field" style={{ flex: 1 }}><span>{label} — manual fallback</span><input className="input" value={manual} onChange={e => setManual(e.target.value)} placeholder={placeholder} autoComplete="off"/></label>
      <button className="button button--primary" type="submit" disabled={!manual.trim()}>Submit code</button>
    </form>
  </section>;
}

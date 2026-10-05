// Lettura barcode con fotocamera (funziona offline). Usa html5-qrcode (ZXing),
// con il lettore nativo BarcodeDetector quando disponibile (Android/Chrome).
let scanner = null;
let lastCode = null, lastTime = 0;

export async function startScanner(elementId, onCode) {
  await stopScanner();
  const F = window.Html5QrcodeSupportedFormats;
  scanner = new window.Html5Qrcode(elementId, {
    verbose: false,
    formatsToSupport: [F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E,
      F.ITF, F.CODABAR, F.DATA_MATRIX, F.QR_CODE],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });
  await scanner.start(
    { facingMode: "environment" },
    { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h, w) * 0.45) }) },
    (text) => {
      const code = String(text).trim();
      const now = Date.now();
      // evita letture doppie della stessa scatola
      if (code === lastCode && now - lastTime < 1800) return;
      lastCode = code; lastTime = now;
      beep();
      if (navigator.vibrate) navigator.vibrate(60);
      onCode(code);
    },
    () => {}
  );
}

export async function stopScanner() {
  if (!scanner) return;
  try { if (scanner.isScanning) await scanner.stop(); scanner.clear(); } catch { /* ignore */ }
  scanner = null;
}

let actx;
function beep() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = 1100; g.gain.value = 0.08;
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.09);
  } catch { /* ignore */ }
}

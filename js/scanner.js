// Lettura barcode con fotocamera (funziona offline).
// Ottimizzato per precisione tra codici vicini e ambienti poco illuminati (torcia)
let scanner = null;
let currentTrack = null;
let torchOn = false;

export async function startScanner(elementId, onCode) {
  await stopScanner();
  torchOn = false;
  const F = window.Html5QrcodeSupportedFormats;
  scanner = new window.Html5Qrcode(elementId, {
    verbose: false,
    formatsToSupport: [
      F.CODE_128, F.CODE_39, F.EAN_13, F.UPC_A, F.DATA_MATRIX, F.QR_CODE
    ],
    // Disattiviamo useBarCodeDetectorIfSupported: BarcodeDetector scansiona tutto il sensore
    // ignorando il ritaglio; con false, ZXing scansiona solo l'area delimitata dal mirino!
    experimentalFeatures: { useBarCodeDetectorIfSupported: false },
  });

  // Mirino orizzontale a fessura sottile (altezza ~70-95px):
  // 1. Isola rigorosamente il singolo barcode puntato, ignorando quelli vicini sopra o sotto
  // 2. Posizionato marcatamente più in alto (a circa il 25% dell'altezza anziché in basso o al 50%)
  //    in modo che l'operatore inquadri comodamente al centro-alto dello schermo
  // 3. Linea laser rossa allineata al millimetro con il centro esatto della fessura di decodifica
  const config = {
    fps: 10,
    qrbox: (w, h) => {
      const boxWidth = Math.floor(w * 0.86);
      const boxHeight = Math.max(70, Math.min(95, Math.floor(h * 0.20)));
      const y = Math.floor(h * 0.25);

      // Allinea al millimetro la linea laser rossa con il centro esatto dell'area attiva
      try {
        const wrap = document.getElementById(elementId)?.closest(".reader-wrap") || document.querySelector(".reader-wrap");
        const laser = wrap ? wrap.querySelector(".scan-laser") : document.querySelector(".scan-laser");
        if (laser) {
          laser.style.top = `${y + Math.floor(boxHeight / 2)}px`;
        }
      } catch (e) {}

      return { width: boxWidth, height: boxHeight, y };
    },
  };

  await scanner.start(
    { facingMode: "environment" },
    config,
    async (text) => {
      const code = String(text).trim();
      if (!code) return;
      beep();
      if (navigator.vibrate) navigator.vibrate(60);

      // FERMA SUBITO LO SCANNER: nessuna lettura precipitosa o successiva finché l'operatore non lo richiede!
      await stopScanner();
      onCode(code);
    },
    () => {}
  );

  // Recupera la traccia video per controllare la torcia (flash)
  try {
    const video = document.querySelector(`#${elementId} video`) || document.querySelector(".reader video");
    if (video && video.srcObject) {
      currentTrack = video.srcObject.getVideoTracks()[0] || null;
    }
  } catch (e) {
    currentTrack = null;
  }
}

export function isTorchSupported() {
  if (currentTrack) {
    try {
      const caps = currentTrack.getCapabilities ? currentTrack.getCapabilities() : {};
      if (caps.torch) return true;
    } catch (e) {}
  }
  if (scanner) {
    try {
      const caps = scanner.getRunningTrackCameraCapabilities();
      if (caps && caps.isTorchFeatureSupported && caps.isTorchFeatureSupported()) return true;
    } catch (e) {}
  }
  return false;
}

export async function toggleTorch() {
  torchOn = !torchOn;
  let ok = false;
  if (currentTrack) {
    try {
      await currentTrack.applyConstraints({ advanced: [{ torch: torchOn }] });
      ok = true;
    } catch (e) {}
  }
  if (!ok && scanner) {
    try {
      await scanner.applyVideoConstraints({ advanced: [{ torch: torchOn }] });
      ok = true;
    } catch (e) {}
  }
  return torchOn;
}

export function isTorchOn() {
  return torchOn;
}

export async function stopScanner() {
  torchOn = false;
  currentTrack = null;
  if (!scanner) return;
  try {
    if (scanner.isScanning) {
      await Promise.race([
        scanner.stop(),
        new Promise(r => setTimeout(r, 800))
      ]);
    }
    scanner.clear();
  } catch { /* ignore */ }
  scanner = null;
}

let actx;
function beep() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = 1100; g.gain.value = 0.08;
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.09);
  } catch { /* ignore */ }
}

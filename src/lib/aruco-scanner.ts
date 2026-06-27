/**
 * Tarayıcı taraflı ArUco marker tespiti.
 *
 * js-aruco2 CJS modülü Vite/rolldown ile bundle edilemiyor.
 * Bunun yerine üç script dosyasını public/aruco/ dizininden
 * dinamik <script> tag ile yükleriz — Vite hiç dahil olmaz.
 *
 * Yükleme sırası:
 *   1. /aruco/cv.js          → window.CV
 *   2. /aruco/aruco.js       → window.AR  (window.CV'yi okur)
 *   3. /aruco/aruco_4x4_1000.js → window.AR.DICTIONARIES['ARUCO_4X4_1000']
 */

export interface DetectedMarker {
  id: number
  corners: Array<{ x: number; y: number }>
}

// ─── Script yükleme ───────────────────────────────────────────────────────────

let _loadPromise: Promise<void> | null = null

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.onload  = () => resolve()
    s.onerror = () => reject(new Error(`Script yüklenemedi: ${src}`))
    document.head.appendChild(s)
  })
}

async function ensureLoaded(): Promise<void> {
  if (_loadPromise) return _loadPromise
  _loadPromise = (async () => {
    await loadScript('/aruco/cv.js')
    await loadScript('/aruco/aruco.js')
    await loadScript('/aruco/aruco_4x4_1000.js')
  })()
  return _loadPromise
}

// ─── Detector ────────────────────────────────────────────────────────────────

let _detector: any = null

async function getDetector(): Promise<any> {
  if (_detector) return _detector
  await ensureLoaded()
  const AR = (window as any).AR
  _detector = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000' })
  return _detector
}

// ─── Tespit ──────────────────────────────────────────────────────────────────

/**
 * ImageData üzerinde ArUco marker tespiti yapar (async — ilk çağrıda script yükler).
 *
 * Tespit stratejisi (2 katman):
 *   1. Ham görüntü → detect
 *   2. Kontrast artırılmış görüntü → detect (düşük ışıkta yardımcı olur)
 */
export async function detectMarkers(imageData: ImageData): Promise<DetectedMarker[]> {
  try {
    const det = await getDetector()

    // Katman 1: Ham görüntü
    const result1: DetectedMarker[] = det.detect(imageData)
    if (result1.length > 0) return result1

    // Katman 2: Kontrast artırma (histogram germe)
    const enhanced = enhanceContrast(imageData)
    const result2: DetectedMarker[] = det.detect(enhanced)
    return result2
  } catch {
    return []
  }
}

/**
 * Betimsel fonksiyon: aruco script'lerini ön-yükle.
 * Scanner sekmesi açılınca çağrılır — gerçek tarama başlamadan hazır olsun.
 */
export function preloadAruco(): void {
  ensureLoaded().catch(() => {/* sessizce başarısız olursa retry edilir */})
}

// ─── Yardımcı ─────────────────────────────────────────────────────────────────

/**
 * Basit histogram germe: parlaklık aralığını [0-255]'e normalize eder.
 * Düşük kontrastlı yüzeylerde tespit oranını artırır.
 */
function enhanceContrast(src: ImageData): ImageData {
  const data = new Uint8ClampedArray(src.data)
  let min = 255
  let max = 0

  for (let i = 0; i < data.length; i += 4) {
    const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    if (lum < min) min = lum
    if (lum > max) max = lum
  }

  const range = max - min || 1
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = Math.round((data[i]     - min) / range * 255)
    data[i + 1] = Math.round((data[i + 1] - min) / range * 255)
    data[i + 2] = Math.round((data[i + 2] - min) / range * 255)
    // alpha değişmez
  }

  return new ImageData(data, src.width, src.height)
}

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
  if (!AR?.Detector) throw new Error('window.AR.Detector bulunamadı — script yüklenememiş olabilir')
  _detector = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000' })
  return _detector
}

// ─── Görüntü ön işleme ───────────────────────────────────────────────────────

const MAX_DETECT_WIDTH = 640

/**
 * Tespit için görüntüyü MAX_DETECT_WIDTH'e küçültür.
 * js-aruco2 yüksek çözünürlüklü görüntülerde (Windows kameraları gibi)
 * başarısız olabiliyor; 640px'de güvenilir çalışıyor.
 */
function downscale(src: ImageData): { data: ImageData; scale: number } {
  if (src.width <= MAX_DETECT_WIDTH) return { data: src, scale: 1 }

  const scale = MAX_DETECT_WIDTH / src.width
  const w = Math.round(src.width * scale)
  const h = Math.round(src.height * scale)

  // ImageData → geçici canvas → küçültülmüş canvas → yeni ImageData
  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = src.width
  srcCanvas.height = src.height
  srcCanvas.getContext('2d')!.putImageData(src, 0, 0)

  const dstCanvas = document.createElement('canvas')
  dstCanvas.width = w
  dstCanvas.height = h
  const dstCtx = dstCanvas.getContext('2d')!
  dstCtx.drawImage(srcCanvas, 0, 0, w, h)

  return { data: dstCtx.getImageData(0, 0, w, h), scale }
}

/**
 * Alpha kanalını 255'e zorla.
 * Windows'ta bazı GPU sürücüleri canvas'tan premultiplied alpha döndürür;
 * bu durum js-aruco2'nin eşikleme adımını bozuyor.
 */
function normalizeAlpha(src: ImageData): ImageData {
  const data = new Uint8ClampedArray(src.data)
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  return new ImageData(data, src.width, src.height)
}

/**
 * Küçültülmüş görüntüdeki köşe koordinatlarını orijinal video boyutuna ölçekle.
 * (scale = 0.5 → köşe koordinatları 2× büyütülür)
 */
function scaleCorners(markers: DetectedMarker[], scale: number): DetectedMarker[] {
  if (scale === 1) return markers
  return markers.map(m => ({
    id: m.id,
    corners: m.corners.map(c => ({ x: c.x / scale, y: c.y / scale })),
  }))
}

// ─── Tespit ──────────────────────────────────────────────────────────────────

/**
 * ImageData üzerinde ArUco marker tespiti yapar (async — ilk çağrıda script yükler).
 *
 * Tespit stratejisi (2 katman):
 *   1. Alpha normalize → downscale → detect
 *   2. Kontrast artırılmış → detect  (düşük ışıkta yardımcı olur)
 *
 * Alpha normalizasyonu downscale'den önce yapılır: drawImage sırasında
 * browser compositing'i alpha < 255 olan piksellerin RGB kanallarını
 * bozabilir (Windows GPU sürücülerinde yaygın).
 */
export async function detectMarkers(imageData: ImageData): Promise<DetectedMarker[]> {
  try {
    const det = await getDetector()

    // Alpha önce normalize et, sonra downscale — sıra önemli
    const normalized = normalizeAlpha(imageData)
    const { data: scaled, scale } = downscale(normalized)

    // Katman 1: Normalize + downscaled
    const result1: DetectedMarker[] = det.detect(scaled)
    if (result1.length > 0) return scaleCorners(result1, scale)

    // Katman 2: Kontrast artırma
    const enhanced = enhanceContrast(scaled)
    const result2: DetectedMarker[] = det.detect(enhanced)
    if (result2.length > 0) return scaleCorners(result2, scale)

    return []
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

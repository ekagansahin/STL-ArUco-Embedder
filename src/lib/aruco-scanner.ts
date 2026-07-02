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
 *   3. /aruco/aruco_4x4_50.js → window.AR.DICTIONARIES['ARUCO_4X4_50']
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
  // base-relative yol: GitHub Pages alt dizininde (/STL-ArUco-Embedder/) de doğru çözülsün.
  // import.meta.env.BASE_URL daima '/' ile biter (dev'de '/', prod'da '/STL-ArUco-Embedder/').
  const base = import.meta.env.BASE_URL
  _loadPromise = (async () => {
    await loadScript(`${base}aruco/cv.js`)
    await loadScript(`${base}aruco/aruco.js`)
    await loadScript(`${base}aruco/aruco_4x4_50.js`)
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
  _detector = new AR.Detector({ dictionaryName: 'ARUCO_4X4_50' })
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
 * Tespit stratejisi — ön işleme × yön matrisi:
 *   Ön işleme varyantları (ucuzdan pahalıya):
 *     1. Ham (yalnız normalize + downscale)
 *     2. Global kontrast germe (enhanceContrast)
 *     3. CLAHE — yerel adaptif kontrast (tek renk gravür markerlar için)
 *   Her varyant iki yönde denenir:
 *     a. Düz
 *     b. Yatay çevrilmiş (ayna)
 *
 * NEDEN matris: Baskıda marker parçanın alt yüzüne gömülü olduğundan kamera
 * onu her zaman AYNALI görür; js-aruco2 motoru içeride yalnızca 4 rotasyon
 * dener, aynayı denemez — bu yüzden kareyi biz çeviririz. Ayrıca tek renk
 * gravürde kontrast yalnızca oyukların gölgesinden gelir (çok düşük ve yerel),
 * bu yüzden ayna telafisi ile kontrast güçlendirmenin AYNI ANDA uygulanması
 * gerekir. Eski kodda flip yalnız ham kareye uygulanıyordu; flip + kontrast
 * kombinasyonu hiç denenmiyordu.
 *
 * İlk tutan varyant kazanır (kısa devre) → tipik karede ilk varyant döner,
 * ekstra maliyet olmaz. Aynalı yönde köşeler ham kare uzayına geri çevrilir
 * (x' = width - x); ID zaten doğru çıkar.
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

    // Ön işleme varyantları — tembel değil, sırayla üretilir ki gereksiz
    // pahalı işlem (CLAHE) erken tutanda hiç çalışmasın.
    const variantFns: Array<(img: ImageData) => ImageData> = [
      (img) => img,          // ham
      enhanceContrast,       // global germe
      clahe,                 // yerel adaptif kontrast
    ]

    for (const makeVariant of variantFns) {
      const variant = makeVariant(scaled)

      // a. Düz
      const direct: DetectedMarker[] = det.detect(variant)
      if (direct.length > 0) return scaleCorners(direct, scale)

      // b. Aynalı — köşeleri ham kare uzayına geri çevir (x' = width - x)
      const flipped = flipHorizontal(variant)
      const mirrored: DetectedMarker[] = det.detect(flipped)
      if (mirrored.length > 0) {
        const unflipped = mirrored.map(m => ({
          id: m.id,
          corners: m.corners.map(c => ({ x: variant.width - c.x, y: c.y })),
        }))
        return scaleCorners(unflipped, scale)
      }
    }

    return []
  } catch {
    return []
  }
}

/**
 * Görüntüyü yatay (X) çevirir — ayna-dayanıklı tespit için.
 */
function flipHorizontal(src: ImageData): ImageData {
  const { width: w, height: h, data } = src
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4
      const di = (y * w + (w - 1 - x)) * 4
      out[di]     = data[si]
      out[di + 1] = data[si + 1]
      out[di + 2] = data[si + 2]
      out[di + 3] = data[si + 3]
    }
  }
  return new ImageData(out, w, h)
}

/**
 * aruco script'lerini ön-yükle. Promise döndürür: çağıran yükleme
 * başarısını/başarısızlığını izleyebilir (UI'da hata göstermek için).
 */
export function preloadAruco(): Promise<void> {
  return ensureLoaded()
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

/**
 * CLAHE — Contrast Limited Adaptive Histogram Equalization.
 *
 * Global germenin (enhanceContrast) aksine kontrastı YEREL olarak açar:
 * görüntüyü karolara böler, her karoda histogram eşitler, clipLimit ile
 * gürültü patlamasını sınırlar ve karolar arası bilineer interpolasyonla
 * blok sınırı artefaktını yok eder. Tek renk 3D-baskı gravür markerlarda
 * kontrast yalnız oyukların yerel gölgesinden geldiği için bu, düz
 * germeden çok daha etkilidir.
 *
 * Sonuç grayscale'dir (R=G=B=eşitlenmiş luma); alpha korunur.
 */
function clahe(src: ImageData, tiles = 8, clipLimit = 3.0): ImageData {
  const { width: w, height: h, data } = src
  const bins = 256

  // Luma kanalı
  const lum = new Uint8Array(w * h)
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    lum[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)
  }

  const tw = Math.max(1, Math.floor(w / tiles))
  const th = Math.max(1, Math.floor(h / tiles))
  const nx = Math.ceil(w / tw)
  const ny = Math.ceil(h / th)

  // Her karo için 256-girişli eşleme (LUT) hesapla
  const maps: Uint8Array[] = new Array(nx * ny)
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const x0 = tx * tw, y0 = ty * th
      const x1 = Math.min(x0 + tw, w), y1 = Math.min(y0 + th, h)

      const hist = new Float32Array(bins)
      let count = 0
      for (let y = y0; y < y1; y++) {
        const rowOff = y * w
        for (let x = x0; x < x1; x++) { hist[lum[rowOff + x]]++; count++ }
      }

      // Clip + fazlalığı eşit dağıt
      const clip = Math.max(1, (clipLimit * count) / bins)
      let excess = 0
      for (let b = 0; b < bins; b++) if (hist[b] > clip) { excess += hist[b] - clip; hist[b] = clip }
      const inc = excess / bins
      for (let b = 0; b < bins; b++) hist[b] += inc

      // CDF → 0-255 eşleme
      const map = new Uint8Array(bins)
      const total = count || 1
      let cdf = 0
      for (let b = 0; b < bins; b++) {
        cdf += hist[b]
        map[b] = Math.max(0, Math.min(255, Math.round((cdf / total) * 255)))
      }
      maps[ty * nx + tx] = map
    }
  }

  // Piksel başına bilineer interpolasyonla eşle
  const out = new Uint8ClampedArray(data)
  for (let y = 0; y < h; y++) {
    const gy = (y + 0.5) / th - 0.5
    let ty0 = Math.floor(gy)
    let fy = gy - ty0
    if (ty0 < 0) { ty0 = 0; fy = 0 }
    if (ty0 > ny - 1) { ty0 = ny - 1; fy = 0 }
    const ty1 = Math.min(ty0 + 1, ny - 1)

    for (let x = 0; x < w; x++) {
      const gx = (x + 0.5) / tw - 0.5
      let tx0 = Math.floor(gx)
      let fx = gx - tx0
      if (tx0 < 0) { tx0 = 0; fx = 0 }
      if (tx0 > nx - 1) { tx0 = nx - 1; fx = 0 }
      const tx1 = Math.min(tx0 + 1, nx - 1)

      const v = lum[y * w + x]
      const m00 = maps[ty0 * nx + tx0][v]
      const m01 = maps[ty0 * nx + tx1][v]
      const m10 = maps[ty1 * nx + tx0][v]
      const m11 = maps[ty1 * nx + tx1][v]
      const top = m00 * (1 - fx) + m01 * fx
      const bot = m10 * (1 - fx) + m11 * fx
      const val = Math.round(top * (1 - fy) + bot * fy)

      const i = (y * w + x) * 4
      out[i] = out[i + 1] = out[i + 2] = val
      // alpha korunur
    }
  }

  return new ImageData(out, w, h)
}

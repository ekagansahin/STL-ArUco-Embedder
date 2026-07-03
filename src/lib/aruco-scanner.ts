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

import { detectWithOpenCV, preloadOpenCV } from './aruco-opencv'

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

/**
 * Tespit ölçekleri. 640: js-aruco2'nin güvenilir çalıştığı hızlı yol
 * (yüksek çözünürlükte başarısız olabiliyor). 1024: uzak çekimde küçük
 * markerlarda (10mm marker ≈ hücre başına <8px) 640 yetersiz kalıyor;
 * ikinci geçiş daha fazla pikselle dener.
 */
const DETECT_WIDTHS = [640, 1024]

/**
 * Tespit için görüntüyü maxWidth'e küçültür.
 */
function downscale(src: ImageData, maxWidth: number): { data: ImageData; scale: number } {
  if (src.width <= maxWidth) return { data: src, scale: 1 }

  const scale = maxWidth / src.width
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
 * Tespit stratejisi — ölçek × ön işleme × polarite × yön matrisi:
 *   Ölçekler: 640 (hızlı yol) → 1024 (küçük/uzak marker)
 *   Ön işleme varyantları (ucuzdan pahalıya):
 *     1. Ham (yalnız normalize + downscale)
 *     2. Global kontrast germe (enhanceContrast)
 *     3. CLAHE — yerel adaptif kontrast (tek renk gravür markerlar için)
 *     4. Black-hat morfoloji — hücre ölçeğindeki koyu çukurları izole eder
 *   Her varyant iki polaritede (normal + negatif) ve iki yönde (düz + ayna)
 *   denenir.
 *
 * NEDEN matris: Baskıda marker parçanın alt yüzüne gömülü olduğundan kamera
 * onu her zaman AYNALI görür; js-aruco2 motoru içeride yalnızca 4 rotasyon
 * dener, aynayı denemez — bu yüzden kareyi biz çeviririz. Tek renk gravürde
 * kontrast yalnızca oyukların gölgesinden gelir (çok düşük ve yerel). Parlak
 * yüzeylerde (PEI tabanı gibi) ışık açısına göre polarite TERS dönebilir:
 * düz yüzey speküler karanlık, oyuklar açık görünür — negatif varyant bunu
 * yakalar. Black-hat (morfolojik kapama − orijinal) ise hücre boyutundaki
 * koyu bölgeleri arka plandan bağımsız çıkarır; kademeli aydınlatma ve zayıf
 * gölge kontrastında CLAHE'den daha hedeflidir.
 *
 * İlk tutan varyant kazanır (kısa devre) → tipik karede ilk varyantlar döner,
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

    // ── Birincil yol: OpenCV ArucoDetector (hazırsa) ──────────────────────
    // Adaptif eşik taraması + subpixel köşe + detectInvertedMarker.
    // Düşük kontrastlı gravürde js-aruco2'den kat kat güçlü. 1280px'e kadar
    // çözünürlük bırakılır (küçük marker için piksel gerekir). null dönerse
    // (wasm henüz yüklenmedi/başarısız) aşağıdaki js-aruco2 matrisi devrede.
    {
      const { data: cvScaled, scale: cvScale } = downscale(normalized, 1280)
      const cvResult = detectWithOpenCV(cvScaled)
      if (cvResult && cvResult.length > 0) return scaleCorners(cvResult, cvScale)
    }

    // ── Fallback: js-aruco2 matrisi ───────────────────────────────────────
    for (const maxWidth of DETECT_WIDTHS) {
      const { data: scaled, scale } = downscale(normalized, maxWidth)

      // Ön işleme varyantları — tembel değil, sırayla üretilir ki gereksiz
      // pahalı işlem (CLAHE, black-hat) erken tutanda hiç çalışmasın.
      const variantFns: Array<(img: ImageData) => ImageData> = [
        (img) => img,          // ham
        enhanceContrast,       // global germe
        clahe,                 // yerel adaptif kontrast
        blackHat,              // morfolojik çukur çıkarımı
      ]

      for (const makeVariant of variantFns) {
        const variant = makeVariant(scaled)

        for (const polarize of [
          (img: ImageData) => img,  // normal
          invert,                   // negatif — ters polarite (parlak yüzey)
        ]) {
          const polarized = polarize(variant)

          // a. Düz
          const direct: DetectedMarker[] = det.detect(polarized)
          if (direct.length > 0) return scaleCorners(direct, scale)

          // b. Aynalı — köşeleri ham kare uzayına geri çevir (x' = width - x)
          const flipped = flipHorizontal(polarized)
          const mirrored: DetectedMarker[] = det.detect(flipped)
          if (mirrored.length > 0) {
            const unflipped = mirrored.map(m => ({
              id: m.id,
              corners: m.corners.map(c => ({ x: polarized.width - c.x, y: c.y })),
            }))
            return scaleCorners(unflipped, scale)
          }
        }
      }

      // Kaynak zaten bu ölçekten küçükse büyük ölçeği denemenin anlamı yok
      if (normalized.width <= maxWidth) break
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
 * OpenCV wasm yüklemesi de arka planda başlatılır (bloklamaz);
 * hazır olana kadar js-aruco2 çalışır.
 */
export function preloadAruco(): Promise<void> {
  preloadOpenCV()
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
 * Negatif — RGB kanallarını ters çevirir (alpha korunur).
 * Parlak/speküler yüzeylerde oyuklar arka plandan AÇIK görünebilir;
 * detektör siyah hücre beklediği için polarite çevirisi gerekir.
 */
function invert(src: ImageData): ImageData {
  const data = new Uint8ClampedArray(src.data)
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = 255 - data[i]
    data[i + 1] = 255 - data[i + 1]
    data[i + 2] = 255 - data[i + 2]
  }
  return new ImageData(data, src.width, src.height)
}

/**
 * Black-hat morfolojisi: closing(luma) − luma.
 * Yapı elemanından (kare, yarıçap ≈ hücre boyutu) KÜÇÜK koyu bölgeleri —
 * yani gravür oyuklarını — aydınlatma gradyanından bağımsız izole eder.
 * Çıktı: çukurlar siyah, arka plan beyaz (normalize + ters çevrilmiş),
 * grayscale ImageData.
 *
 * Dilate/erode ayrıştırılabilir (yatay + dikey 1D geçiş) → O(w·h·r).
 * 640px'de r≈8 ile ~10ms mertebesi.
 */
function blackHat(src: ImageData): ImageData {
  const { width: w, height: h, data } = src
  const radius = Math.max(4, Math.round(w / 80)) // 640→8, 1024→13

  // Luma
  const lum = new Uint8Array(w * h)
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    lum[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)
  }

  // Ayrıştırılabilir morfoloji: 1D pencere min/max, önce satır sonra sütun
  const pass = (input: Uint8Array, horizontal: boolean, isMax: boolean): Uint8Array => {
    const out = new Uint8Array(w * h)
    const outer = horizontal ? h : w
    const inner = horizontal ? w : h
    for (let o = 0; o < outer; o++) {
      for (let i = 0; i < inner; i++) {
        let best = isMax ? 0 : 255
        const lo = Math.max(0, i - radius)
        const hi = Math.min(inner - 1, i + radius)
        for (let k = lo; k <= hi; k++) {
          const v = horizontal ? input[o * w + k] : input[k * w + o]
          if (isMax ? v > best : v < best) best = v
        }
        if (horizontal) out[o * w + i] = best
        else out[i * w + o] = best
      }
    }
    return out
  }

  // closing = erode(dilate(x))
  const dilated = pass(pass(lum, true, true), false, true)
  const closed  = pass(pass(dilated, true, false), false, false)

  // black-hat = closing − orijinal; normalize et
  const bh = new Uint8Array(w * h)
  let maxV = 1
  for (let p = 0; p < bh.length; p++) {
    const v = closed[p] - lum[p]
    bh[p] = v > 0 ? v : 0
    if (bh[p] > maxV) maxV = bh[p]
  }

  // Çukur → siyah, arka plan → beyaz (detektör siyah hücre bekler)
  const out = new Uint8ClampedArray(data.length)
  for (let p = 0, i = 0; p < bh.length; p++, i += 4) {
    const v = 255 - Math.round((bh[p] / maxV) * 255)
    out[i] = out[i + 1] = out[i + 2] = v
    out[i + 3] = 255
  }
  return new ImageData(out, w, h)
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

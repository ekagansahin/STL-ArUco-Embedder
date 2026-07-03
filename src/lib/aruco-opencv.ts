/**
 * OpenCV.js tabanlı ArUco detektörü — birincil tespit motoru.
 *
 * NEDEN: js-aruco2 tek global eşikle çalışır; tek renk gravür markerlarda
 * (kontrast yalnız oyuk gölgesinden, Δ~15-30 gri seviyesi) başarısız olur.
 * OpenCV ArucoDetector adaptif eşik penceresi TARAMASI yapar
 * (adaptiveThreshWinSizeMin→Max), subpixel köşe rafinasyonu uygular ve
 * detectInvertedMarker ile ters polariteyi (parlak yüzeyde açık görünen
 * oyuklar) motor içinde dener. Sentetik testte Δ=20 kontrastta tespit
 * doğrulandı.
 *
 * Maliyet: ~13 MB script (wasm gömülü). Bu yüzden:
 *  - Tembel yüklenir (ilk çağrıda, arka planda)
 *  - Yüklenene kadar / yükleme başarısız olursa js-aruco2 devrede kalır
 *    (aruco-scanner.ts fallback matrisi)
 *
 * YÜKLEME YOLU: public/opencv/opencv.js'ten dinamik <script> tag ile —
 * js-aruco2 ile AYNI desen. npm modülü (@techstark/opencv-js) Vite/rolldown
 * CJS interop'undan bundle edilince tarayıcıda yüklenemiyordu (sahada
 * sürekli "OpenCV yüklenemedi"); js-aruco2 da aynı sebeple public/'te.
 * Dosya: node_modules/@techstark/opencv-js/dist/opencv.js kopyası
 * (v5.0.0-release.1). Güncellerken yeniden kopyala.
 *
 * Ayna: baskıda marker alt yüzeye gömülü olduğundan kamera AYNALI görür.
 * detectInvertedMarker polariteyi çözer ama aynayı ÇÖZMEZ (aynalı desen
 * sözlükte başka/geçersiz koda düşer) — kareyi kendimiz çevirip köşeleri
 * geri eşleriz (x' = width − x).
 */

import type { DetectedMarker } from './aruco-scanner'
import arucoDict from '../assets/aruco_dict_4x4_50.json'

let _cv: any = null
let _loadStarted = false
let _loadFailed = false
let _detector: any = null

const LOAD_TIMEOUT_MS = 60_000 // 13MB script + wasm derleme — yavaş ağda cömert davran

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload  = () => resolve()
    s.onerror = () => reject(new Error(`Script yüklenemedi: ${src}`))
    document.head.appendChild(s)
  })
}

/** OpenCV yüklemesini başlat (idempotent, arka plan). */
export function preloadOpenCV(): void {
  if (_loadStarted) return
  _loadStarted = true
  ;(async () => {
    try {
      const base = import.meta.env.BASE_URL
      await loadScript(`${base}opencv/opencv.js`)

      // UMD, window.cv'yi bırakır. Sürüme göre üç olası durum:
      // 1) thenable (emscripten Promise-benzeri) → await
      // 2) onRuntimeInitialized callback bekleyen modül
      // 3) çoktan hazır (cv.Mat mevcut)
      const raw: any = (window as any).cv
      if (!raw) throw new Error('window.cv oluşmadı')

      const cv = await Promise.race([
        (async () => {
          if (typeof raw.then === 'function') return await raw
          if (raw.Mat) return raw
          return await new Promise<any>((resolve) => {
            raw.onRuntimeInitialized = () => resolve(raw)
          })
        })(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('OpenCV runtime zaman aşımı')), LOAD_TIMEOUT_MS)
        ),
      ])

      if (!cv?.Mat) throw new Error('OpenCV runtime eksik (cv.Mat yok)')
      _cv = cv
    } catch (e) {
      _loadFailed = true
      console.warn('[aruco] OpenCV yüklenemedi — js-aruco2 fallback aktif:', e)
    }
  })()
}

/**
 * ÖZEL sözlüğü cv.aruco_Dictionary olarak kur.
 *
 * DİKKAT: Bizim sözlük OpenCV'nin hazır DICT_4X4_50'si DEĞİL —
 * ARUCO_4X4_1000'den max-min Hamming ile seçilip 0-49'a yeniden
 * numaralanmış özel 50'lik (aruco_dict_4x4_50.json, 6×6, 1=SİYAH).
 * Hazır sözlük kullanılsaydı ID'ler basılı parçalarla uyuşmazdı.
 *
 * OpenCV 5 bytesList düzeni (empirik doğrulandı, node testi):
 *   Mat CV_8UC4, rows=N, cols=ceil(bits/8)=2; satır başına 8 bayt:
 *   [rot0_b0, rot0_b1, rotCCW_b0, rotCCW_b1, rot180_..., rotCW_...]
 *   Baytlar MSB-first, bit=1 → BEYAZ hücre (JSON'un tersi).
 */
function buildCustomDictionary(cv: any): any {
  const rotCCW = (b: number[][]) => {
    const o = Array.from({ length: 4 }, () => Array(4).fill(0))
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[3 - c][r] = b[r][c]
    return o
  }
  const toBytes = (b: number[][]) => {
    const by = [0, 0]
    let i = 0
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      by[i >> 3] |= b[r][c] << (7 - (i & 7))
      i++
    }
    return by
  }
  const N = arucoDict.length
  const data = new Uint8Array(N * 8)
  for (let id = 0; id < N; id++) {
    const b6 = arucoDict[id] as number[][]
    // iç 4×4, 1=beyaz (JSON 1=siyah → ters çevir)
    let cur: number[][] = []
    for (let r = 1; r < 5; r++) {
      const row: number[] = []
      for (let c = 1; c < 5; c++) row.push(1 - b6[r][c])
      cur.push(row)
    }
    for (let rot = 0; rot < 4; rot++) {
      const by = toBytes(cur)
      data[id * 8 + rot * 2] = by[0]
      data[id * 8 + rot * 2 + 1] = by[1]
      cur = rotCCW(cur)
    }
  }
  const bytesList = cv.matFromArray(N, 2, cv.CV_8UC4, Array.from(data))
  // maxCorrectionBits=1: sözlüğümüzün min Hamming mesafesi 4 → 1 bit güvenli
  return new cv.aruco_Dictionary(bytesList, 4, 1)
}

/** Hazırsa detektörü döndürür; değilse null (bloklamaz — fallback devrede). */
function getDetectorIfReady(): any | null {
  if (_detector) return _detector
  if (!_cv) { preloadOpenCV(); return null }
  try {
    const cv = _cv
    const dict = buildCustomDictionary(cv)
    const params = new cv.aruco_DetectorParameters()
    // Düşük kontrastlı gravür için ayarlar:
    params.detectInvertedMarker = true   // ters polarite motor içinde
    params.adaptiveThreshConstant = 5    // varsayılan 7 → zayıf gölgede daha duyarlı
    // minMarkerPerimeterRate varsayılanda (0.03) bırakıldı: 0.02 dokulu arka
    // planlarda (ahşap masa vb.) sahte kare oranını gözle görülür artırıyordu
    params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX ?? 1
    const refine = new cv.aruco_RefineParameters(10, 3, true)
    _detector = new cv.aruco_ArucoDetector(dict, params, refine)
    return _detector
  } catch (e) {
    _loadFailed = true
    console.warn('[aruco] OpenCV detektörü kurulamadı — js-aruco2 fallback aktif:', e)
    return null
  }
}

export function isOpenCVFailed(): boolean {
  return _loadFailed
}

/** UI göstergesi için motor durumu. */
export function openCVStatus(): 'loading' | 'ready' | 'failed' {
  if (_loadFailed) return 'failed'
  if (_cv) return 'ready'
  return 'loading'
}

/** MatVector köşelerini DetectedMarker[]'a çevir. */
function extractMarkers(corners: any, ids: any): DetectedMarker[] {
  const out: DetectedMarker[] = []
  for (let i = 0; i < ids.rows; i++) {
    const m = corners.get(i) // 1×4 CV_32FC2
    const d = m.data32F
    out.push({
      id: ids.data32S[i],
      corners: [
        { x: d[0], y: d[1] }, { x: d[2], y: d[3] },
        { x: d[4], y: d[5] }, { x: d[6], y: d[7] },
      ],
    })
    m.delete()
  }
  return out
}

/**
 * OpenCV ile tespit. Hazır değilse/başarısızsa null döner (→ js-aruco2
 * fallback). Varyantlar: {ham, CLAHE} × {ayna, düz}. Polarite motor içinde.
 *
 * ADAY BİRLEŞTİRME — erken dönüş YOK: dokulu arka planlar (ahşap masa vb.)
 * sahte kare üretebilir; ilk bulunanla dönmek gerçek markerı (başka
 * varyant/yönde çıkacak olanı) bastırır ve yanlış ID kilidi engelleyip
 * fallback'i de susturur. Bunun yerine 4 geçişin TÜM sonuçları toplanır,
 * ID bazında tekilleştirilir; seçim üst katmanda (ScannerPage, kayıtlı-ID
 * filtresi) yapılır. AYNA ÖNCE listelenir: fiziksel markerlar alt yüzeye
 * gömülü olduğundan kamera onları her zaman aynalı görür — beklenen yön bu.
 */
export function detectWithOpenCV(imageData: ImageData): DetectedMarker[] | null {
  const det = getDetectorIfReady()
  if (!det) return null
  const cv = _cv

  let src: any = null, gray: any = null, claheMat: any = null, flipped: any = null
  try {
    src = cv.matFromImageData(imageData)
    gray = new cv.Mat()
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

    // CLAHE varyantı — yerel kontrast (tek renk gravür gölgeleri için)
    const makeClahe = () => {
      if (claheMat) return claheMat
      claheMat = new cv.Mat()
      const c = new cv.CLAHE(3.0, new cv.Size(8, 8))
      c.apply(gray, claheMat)
      c.delete()
      return claheMat
    }

    const found: DetectedMarker[] = []
    const seen = new Set<number>()
    const push = (list: DetectedMarker[]) => {
      for (const m of list) {
        if (!seen.has(m.id)) { seen.add(m.id); found.push(m) }
      }
    }

    for (const variant of [() => gray, makeClahe]) {
      const mat = variant()

      // a. Aynalı ÖNCE — köşeleri ham kare uzayına geri eşle (x' = w − x)
      if (!flipped) flipped = new cv.Mat()
      cv.flip(mat, flipped, 1)
      push(runDetect(cv, det, flipped).map(m => ({
        id: m.id,
        corners: m.corners.map(c => ({ x: imageData.width - c.x, y: c.y })),
      })))

      // b. Düz
      push(runDetect(cv, det, mat))
    }
    return found
  } catch {
    return null // hata → fallback'e bırak
  } finally {
    src?.delete(); gray?.delete(); claheMat?.delete(); flipped?.delete()
  }
}

function runDetect(cv: any, det: any, mat: any): DetectedMarker[] {
  const corners = new cv.MatVector()
  const ids = new cv.Mat()
  try {
    det.detectMarkers(mat, corners, ids)
    return extractMarkers(corners, ids)
  } finally {
    corners.delete(); ids.delete()
  }
}

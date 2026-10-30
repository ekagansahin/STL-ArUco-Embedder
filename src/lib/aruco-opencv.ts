/**
 * OpenCV.js-based ArUco detector — the primary detection engine.
 *
 * WHY: js-aruco2 uses a single global threshold and fails on single-colour
 * engraved markers (contrast comes only from pocket shadows, Δ ≈ 15–30 grey levels).
 * OpenCV's ArucoDetector SWEEPS the adaptive-threshold window
 * (adaptiveThreshWinSizeMin→Max), refines corners to sub-pixel accuracy and
 * tries inverted polarity inside the engine via detectInvertedMarker (pockets
 * that look light on a bright surface). Detection was verified on a synthetic
 * test at Δ=20 contrast.
 *
 * Cost: ~13 MB script (wasm embedded). Therefore:
 *  - It is loaded lazily (on first call, in the background)
 *  - Until it has loaded, or if loading fails, js-aruco2 stays active
 *    (fallback matrix in aruco-scanner.ts)
 *
 * LOADING: via a dynamic <script> tag from public/opencv/opencv.js — the
 * SAME pattern as js-aruco2. The npm module (@techstark/opencv-js) failed to
 * load in the browser once bundled through Vite/rolldown's CJS interop (it
 * kept reporting "OpenCV failed to load"); js-aruco2 lives in public/ for the same reason.
 * File: a copy of node_modules/@techstark/opencv-js/dist/opencv.js
 * (v5.0.0-release.1). Copy it again when updating.
 *
 * Mirroring: the marker is embedded in the bottom face, so the camera sees it MIRRORED.
 * detectInvertedMarker handles polarity but NOT mirroring (a mirrored pattern
 * maps to a different/invalid code in the dictionary) — so we flip the frame
 * ourselves and map the corners back (x' = width − x).
 */

import type { DetectedMarker } from './aruco-scanner'
import arucoDict from '../assets/aruco_dict_4x4_50.json'

let _cv: any = null
let _loadStarted = false
let _loadFailed = false
let _detector: any = null

const LOAD_TIMEOUT_MS = 60_000 // 13 MB script + wasm compile — be generous on slow networks

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload  = () => resolve()
    s.onerror = () => reject(new Error(`Failed to load script: ${src}`))
    document.head.appendChild(s)
  })
}

/** Start loading OpenCV (idempotent, in the background). */
export function preloadOpenCV(): void {
  if (_loadStarted) return
  _loadStarted = true
  ;(async () => {
    try {
      const base = import.meta.env.BASE_URL
      await loadScript(`${base}opencv/opencv.js`)

      // The UMD build leaves window.cv behind. Depending on the version, three cases:
      // 1) thenable (emscripten Promise-like) → await
      // 2) a module waiting for the onRuntimeInitialized callback
      // 3) already ready (cv.Mat exists)
      const raw: any = (window as any).cv
      if (!raw) throw new Error('window.cv was not created')

      const cv = await Promise.race([
        (async () => {
          if (typeof raw.then === 'function') return await raw
          if (raw.Mat) return raw
          return await new Promise<any>((resolve) => {
            raw.onRuntimeInitialized = () => resolve(raw)
          })
        })(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('OpenCV runtime initialisation timed out')), LOAD_TIMEOUT_MS)
        ),
      ])

      if (!cv?.Mat) throw new Error('OpenCV runtime incomplete (cv.Mat missing)')
      _cv = cv
    } catch (e) {
      _loadFailed = true
      console.warn('[aruco] OpenCV failed to load — js-aruco2 fallback active:', e)
    }
  })()
}

/**
 * Build our CUSTOM dictionary as a cv.aruco_Dictionary.
 *
 * CAUTION: our dictionary is NOT OpenCV's built-in DICT_4X4_50 — it is a
 * custom set of 50 codes selected from ARUCO_4X4_1000 by max-min Hamming
 * distance and renumbered 0–49 (aruco_dict_4x4_50.json, 6×6, 1=BLACK).
 * With the built-in dictionary the IDs would not match the printed parts.
 *
 * OpenCV 5 bytesList layout (verified empirically with a Node test):
 *   Mat CV_8UC4, rows=N, cols=ceil(bits/8)=2; 8 bytes per row:
 *   [rot0_b0, rot0_b1, rotCCW_b0, rotCCW_b1, rot180_..., rotCW_...]
 *   Bytes are MSB-first, bit=1 → WHITE cell (the inverse of the JSON).
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
    // inner 4×4, 1=white (JSON uses 1=black → invert)
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
  // maxCorrectionBits=1: our dictionary's minimum Hamming distance is 4 → 1 bit is safe
  return new cv.aruco_Dictionary(bytesList, 4, 1)
}

/** Returns the detector if ready; otherwise null (non-blocking — the fallback takes over). */
function getDetectorIfReady(): any | null {
  if (_detector) return _detector
  if (!_cv) { preloadOpenCV(); return null }
  try {
    const cv = _cv
    const dict = buildCustomDictionary(cv)
    const params = new cv.aruco_DetectorParameters()
    // Settings for low-contrast engravings:
    params.detectInvertedMarker = true   // inverted polarity handled inside the engine
    params.adaptiveThreshConstant = 5    // default 7 → more sensitive in weak shadows
    // minMarkerPerimeterRate left at its default (0.03): 0.02 noticeably increased
    // false squares on textured backgrounds (wooden desks etc.)
    params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX ?? 1
    const refine = new cv.aruco_RefineParameters(10, 3, true)
    _detector = new cv.aruco_ArucoDetector(dict, params, refine)
    return _detector
  } catch (e) {
    _loadFailed = true
    console.warn('[aruco] Could not set up the OpenCV detector — js-aruco2 fallback active:', e)
    return null
  }
}

export function isOpenCVFailed(): boolean {
  return _loadFailed
}

/** Engine status for the UI indicator. */
export function openCVStatus(): 'loading' | 'ready' | 'failed' {
  if (_loadFailed) return 'failed'
  if (_cv) return 'ready'
  return 'loading'
}

/** Convert MatVector corners to DetectedMarker[]. */
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
 * Detect with OpenCV. Returns null if not ready or on failure (→ js-aruco2
 * fallback). Variants: {raw, CLAHE} × {mirrored, normal}. Polarity is handled inside the engine.
 *
 * CANDIDATE MERGING — NO early return: textured backgrounds (wooden desks etc.)
 * can produce false squares; returning the first hit would suppress the real marker
 * (the one found in another variant/orientation), and by blocking a wrong-ID lock
 * it would also silence the fallback. Instead, ALL results of the 4 passes are
 * collected and de-duplicated by ID; the choice is made one level up (ScannerPage,
 * registered-ID filter). MIRRORED results are listed FIRST: physical markers are
 * embedded in the bottom face, so the camera always sees them mirrored — that is the expected case.
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

    // CLAHE variant — local contrast (for shadows in single-colour engravings)
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

      // a. Mirrored FIRST — map corners back to the raw frame space (x' = w − x)
      if (!flipped) flipped = new cv.Mat()
      cv.flip(mat, flipped, 1)
      push(runDetect(cv, det, flipped).map(m => ({
        id: m.id,
        corners: m.corners.map(c => ({ x: imageData.width - c.x, y: c.y })),
      })))

      // b. Normal
      push(runDetect(cv, det, mat))
    }
    return found
  } catch {
    return null // error → leave it to the fallback
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

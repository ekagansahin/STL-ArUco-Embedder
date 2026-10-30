/**
 * Browser-side ArUco marker detection.
 *
 * The js-aruco2 CJS module cannot be bundled with Vite/rolldown.
 * Instead, its three script files are loaded from public/aruco/
 * with dynamic <script> tags — Vite is not involved at all.
 *
 * Load order:
 *   1. /aruco/cv.js          → window.CV
 *   2. /aruco/aruco.js       → window.AR  (reads window.CV)
 *   3. /aruco/aruco_4x4_50.js → window.AR.DICTIONARIES['ARUCO_4X4_50']
 */

import { detectWithOpenCV, preloadOpenCV } from './aruco-opencv'

export interface DetectedMarker {
  id: number
  corners: Array<{ x: number; y: number }>
}

/** ROI hint — a rectangle in raw frame coordinates. */
export interface RoiHint {
  x: number
  y: number
  w: number
  h: number
}

// ─── Script loading ───────────────────────────────────────────────────────────

let _loadPromise: Promise<void> | null = null

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.onload  = () => resolve()
    s.onerror = () => reject(new Error(`Failed to load script: ${src}`))
    document.head.appendChild(s)
  })
}

async function ensureLoaded(): Promise<void> {
  if (_loadPromise) return _loadPromise
  // Base-relative path so it also resolves under the GitHub Pages subpath (/STL-ArUco-Embedder/).
  // import.meta.env.BASE_URL always ends with '/' ('/' in dev, '/STL-ArUco-Embedder/' in prod).
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
  if (!AR?.Detector) throw new Error('window.AR.Detector not found — the script may have failed to load')
  _detector = new AR.Detector({ dictionaryName: 'ARUCO_4X4_50' })
  return _detector
}

// ─── Image preprocessing ─────────────────────────────────────────────────────

/**
 * Detection scales. 640: the fast path where js-aruco2 works reliably
 * (it can fail at high resolution). 1024: for small markers in distant shots
 * (10 mm marker ≈ <8 px per cell) 640 is not enough; the second pass
 * tries again with more pixels.
 */
const DETECT_WIDTHS = [640, 1024]

/**
 * Downscales the image to maxWidth for detection.
 */
function downscale(src: ImageData, maxWidth: number): { data: ImageData; scale: number } {
  if (src.width <= maxWidth) return { data: src, scale: 1 }

  const scale = maxWidth / src.width
  const w = Math.round(src.width * scale)
  const h = Math.round(src.height * scale)

  // ImageData → temporary canvas → downscaled canvas → new ImageData
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
 * Force the alpha channel to 255.
 * On Windows some GPU drivers return premultiplied alpha from the canvas,
 * which breaks js-aruco2's thresholding step.
 */
function normalizeAlpha(src: ImageData): ImageData {
  const data = new Uint8ClampedArray(src.data)
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  return new ImageData(data, src.width, src.height)
}

/**
 * Scale corner coordinates in the downscaled image back to the original video size.
 * (scale = 0.5 → corner coordinates are multiplied by 2)
 */
function scaleCorners(markers: DetectedMarker[], scale: number): DetectedMarker[] {
  if (scale === 1) return markers
  return markers.map(m => ({
    id: m.id,
    corners: m.corners.map(c => ({ x: c.x / scale, y: c.y / scale })),
  }))
}

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Detects ArUco markers in ImageData (async — loads the scripts on first call).
 *
 * Detection strategy — a scale × preprocessing × polarity × orientation matrix:
 *   Scales: 640 (fast path) → 1024 (small/distant markers)
 *   Preprocessing variants (cheapest first):
 *     1. Raw (normalise + downscale only)
 *     2. Global contrast stretch (enhanceContrast)
 *     3. CLAHE — local adaptive contrast (for single-colour engraved markers)
 *     4. Black-hat morphology — isolates dark pits at cell scale
 *   Each variant is tried in two polarities (normal + negative) and two
 *   orientations (normal + mirrored).
 *
 * WHY a matrix: the marker is embedded in the part's bottom face, so the camera
 * always sees it MIRRORED; the js-aruco2 engine only tries the 4 rotations
 * internally, never a mirror — so we flip the frame ourselves. On single-colour
 * engravings the contrast comes only from pocket shadows (very low and local). On shiny
 * surfaces (such as a PEI bed texture) polarity can INVERT depending on the light angle:
 * the flat surface looks specularly dark and the pockets light — the negative variant
 * catches this. Black-hat (morphological closing − original) extracts cell-sized
 * dark regions independently of the background; with graded lighting and weak
 * shadow contrast it is more targeted than CLAHE.
 *
 * The first variant that hits wins (short-circuit) → on a typical frame the first
 * variants return, with no extra cost. In the mirrored orientation the corners are
 * mapped back to the raw frame space (x' = width - x); the ID is already correct.
 *
 * Alpha normalisation happens before downscaling: during drawImage, browser
 * compositing can corrupt the RGB channels of pixels with alpha < 255
 * (common with Windows GPU drivers).
 */
export async function detectMarkers(
  imageData: ImageData,
  roi?: RoiHint | null,
): Promise<DetectedMarker[]> {
  // ── ROI fast path ───────────────────────────────────────────────────────
  // If a marker was found in the previous frame, the caller passes an expanded bbox;
  // that region is scanned first (small image → the full variant matrix is much
  // cheaper, and nothing is lost to downscaling). If nothing is found, fall back to the full frame.
  if (roi) {
    const cropped = cropImageData(imageData, roi)
    if (cropped) {
      const inRoi = await detectMarkersFull(cropped.data)
      if (inRoi.length > 0) {
        return inRoi.map(m => ({
          id: m.id,
          corners: m.corners.map(c => ({ x: c.x + cropped.x, y: c.y + cropped.y })),
        }))
      }
    }
  }
  return detectMarkersFull(imageData)
}

async function detectMarkersFull(imageData: ImageData): Promise<DetectedMarker[]> {
  try {
    const det = await getDetector()

    // Normalise alpha first, then downscale — the order matters
    const normalized = normalizeAlpha(imageData)

    // ── Primary path: OpenCV ArucoDetector (if ready) ─────────────────────
    // Adaptive-threshold sweep + sub-pixel corners + detectInvertedMarker.
    // Far stronger than js-aruco2 on low-contrast engravings. Resolution is kept
    // up to 1280 px (small markers need the pixels). If it returns null
    // (wasm not loaded yet / failed), the js-aruco2 matrix below takes over.
    {
      const { data: cvScaled, scale: cvScale } = downscale(normalized, 1280)
      const cvResult = detectWithOpenCV(cvScaled)
      if (cvResult && cvResult.length > 0) return scaleCorners(cvResult, cvScale)
    }

    // ── Fallback: js-aruco2 matrix ────────────────────────────────────────
    for (const maxWidth of DETECT_WIDTHS) {
      const { data: scaled, scale } = downscale(normalized, maxWidth)

      // Preprocessing variants — generated lazily, in order, so the expensive
      // steps (CLAHE, black-hat) never run when an early variant hits.
      const variantFns: Array<(img: ImageData) => ImageData> = [
        (img) => img,          // raw
        enhanceContrast,       // global stretch
        clahe,                 // local adaptive contrast
        blackHat,              // morphological pit extraction
      ]

      for (const makeVariant of variantFns) {
        const variant = makeVariant(scaled)

        for (const polarize of [
          (img: ImageData) => img,  // normal
          invert,                   // negative — inverted polarity (shiny surface)
        ]) {
          const polarized = polarize(variant)

          // a. Normal
          const direct: DetectedMarker[] = det.detect(polarized)
          if (direct.length > 0) return scaleCorners(direct, scale)

          // b. Mirrored — map corners back to the raw frame space (x' = width - x)
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

      // If the source is already smaller than this scale, trying the larger one is pointless
      if (normalized.width <= maxWidth) break
    }

    return []
  } catch {
    return []
  }
}

/**
 * Crops a rectangle from ImageData. The bounds are clamped to the frame;
 * returns null if the remaining area is smaller than 64 px (useless for detection).
 */
function cropImageData(
  src: ImageData,
  roi: RoiHint,
): { data: ImageData; x: number; y: number } | null {
  const x0 = Math.max(0, Math.floor(roi.x))
  const y0 = Math.max(0, Math.floor(roi.y))
  const x1 = Math.min(src.width, Math.ceil(roi.x + roi.w))
  const y1 = Math.min(src.height, Math.ceil(roi.y + roi.h))
  const w = x1 - x0
  const h = y1 - y0
  if (w < 64 || h < 64) return null

  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const srcOff = ((y0 + y) * src.width + x0) * 4
    out.set(src.data.subarray(srcOff, srcOff + w * 4), y * w * 4)
  }
  return { data: new ImageData(out, w, h), x: x0, y: y0 }
}

/**
 * Sharpness measure — variance of the Laplacian.
 * The image is sampled down to ~320 px and the variance of the 4-neighbour Laplacian is returned.
 * Low value = blurry (webcam focus problem). The threshold depends on the content;
 * ScannerPage only shows the hint while "no marker found AND sharpness is low"
 * (keeps false alarms to a minimum).
 */
export function estimateSharpness(src: ImageData): number {
  const step = Math.max(1, Math.round(src.width / 320))
  const w = Math.floor(src.width / step)
  const h = Math.floor(src.height / step)
  const g = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * step * src.width + x * step) * 4
      g[y * w + x] = src.data[i] * 0.299 + src.data[i + 1] * 0.587 + src.data[i + 2] * 0.114
    }
  }
  let sum = 0, sum2 = 0, n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const lap = 4 * g[p] - g[p - 1] - g[p + 1] - g[p - w] - g[p + w]
      sum += lap; sum2 += lap * lap; n++
    }
  }
  if (n === 0) return 0
  const mean = sum / n
  return sum2 / n - mean * mean
}

/**
 * Flips the image horizontally (X) — for mirror-robust detection.
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
 * Preload the aruco scripts. Returns a Promise so the caller can track
 * load success/failure (to show an error in the UI).
 * The OpenCV wasm load is also started in the background (non-blocking);
 * js-aruco2 is used until it is ready.
 */
export function preloadAruco(): Promise<void> {
  preloadOpenCV()
  return ensureLoaded()
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simple histogram stretch: normalises the brightness range to [0–255].
 * Improves the detection rate on low-contrast surfaces.
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
    // alpha unchanged
  }

  return new ImageData(data, src.width, src.height)
}

/**
 * Negative — inverts the RGB channels (alpha is preserved).
 * On shiny/specular surfaces the pockets can look LIGHTER than the background;
 * the detector expects black cells, so the polarity has to be flipped.
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
 * Black-hat morphology: closing(luma) − luma.
 * Isolates dark regions SMALLER than the structuring element (square, radius ≈ cell size) —
 * i.e. the engraved pockets — independently of the lighting gradient.
 * Output: pits black, background white (normalised + inverted),
 * as grayscale ImageData.
 *
 * Dilate/erode are separable (horizontal + vertical 1D passes) → O(w·h·r).
 * Around ~10 ms at 640 px with r≈8.
 */
function blackHat(src: ImageData): ImageData {
  const { width: w, height: h, data } = src
  const radius = Math.max(4, Math.round(w / 80)) // 640→8, 1024→13

  // Luma
  const lum = new Uint8Array(w * h)
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    lum[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)
  }

  // Separable morphology: 1D window min/max, rows first, then columns
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

  // black-hat = closing − original; normalise
  const bh = new Uint8Array(w * h)
  let maxV = 1
  for (let p = 0; p < bh.length; p++) {
    const v = closed[p] - lum[p]
    bh[p] = v > 0 ? v : 0
    if (bh[p] > maxV) maxV = bh[p]
  }

  // Pit → black, background → white (the detector expects black cells)
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
 * Unlike the global stretch (enhanceContrast), it boosts contrast LOCALLY:
 * it splits the image into tiles, equalises the histogram in each tile, limits
 * noise amplification with clipLimit and removes block-boundary artefacts with
 * bilinear interpolation between tiles. On single-colour 3D-printed engraved markers
 * the contrast comes only from the pockets' local shadows, so this is far more
 * effective than a plain stretch.
 *
 * The result is grayscale (R=G=B=equalised luma); alpha is preserved.
 */
function clahe(src: ImageData, tiles = 8, clipLimit = 3.0): ImageData {
  const { width: w, height: h, data } = src
  const bins = 256

  // Luma channel
  const lum = new Uint8Array(w * h)
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    lum[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)
  }

  const tw = Math.max(1, Math.floor(w / tiles))
  const th = Math.max(1, Math.floor(h / tiles))
  const nx = Math.ceil(w / tw)
  const ny = Math.ceil(h / th)

  // Compute a 256-entry mapping (LUT) for each tile
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

      // Clip + redistribute the excess evenly
      const clip = Math.max(1, (clipLimit * count) / bins)
      let excess = 0
      for (let b = 0; b < bins; b++) if (hist[b] > clip) { excess += hist[b] - clip; hist[b] = clip }
      const inc = excess / bins
      for (let b = 0; b < bins; b++) hist[b] += inc

      // CDF → 0–255 mapping
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

  // Map each pixel with bilinear interpolation
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
      // alpha preserved
    }
  }

  return new ImageData(out, w, h)
}

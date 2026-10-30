/**
 * Camera scanner page.
 * Browser-side ARUCO_4X4_50 detection (OpenCV.js primary, js-aruco2 fallback).
 * Prefers a rear-facing camera (facingMode: environment) when one is available.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getPartByMarkerId, getAllParts } from '../lib/db'
import { detectMarkers, preloadAruco, estimateSharpness, type RoiHint } from '../lib/aruco-scanner'
import { openCVStatus } from '../lib/aruco-opencv'
import type { Part } from '../lib/db'

interface ScannerPageProps {
  lang: 'TR' | 'EN'
}

// ── Per-frame voting — time-tiered ──────────────────────────────────────────
// For the first RELAX_AFTER_MS we look for a lock with a STRICT threshold (high confidence).
// If nothing is found in that time, we drop to the RELAXED threshold and keep trying.
// If there is still no lock once GIVEUP_AFTER_MS has passed, "not found" is shown.
// Note: each threshold means "at least M of the last N frames". The buffer is kept as
// long as the largest window; counting uses the current phase's window.
const VOTE_STRICT   = { window: 7, min: 4 }
const VOTE_RELAXED  = { window: 4, min: 2 }
const RELAX_AFTER_MS  = 3000   // relax after 3 s
const GIVEUP_AFTER_MS = 15000  // give up after 15 s

// Detection rate limit: RAF runs at 60 fps, but detection (especially OpenCV +
// the variant matrix) isn't needed on every frame; ~10 fps is enough and frees
// the main thread — the video and overlay stay smooth.
const MIN_DETECT_INTERVAL_MS = 100

// ROI tracking: once a marker is found, its bbox is expanded by this factor and
// only that region is scanned first in the following frames. After this many
// consecutive misses we go back to the full frame.
const ROI_EXPAND = 1.8
const ROI_MAX_MISSES = 10

// Blur: if no marker has been seen for this long and the Laplacian variance is
// below the threshold, a "blurry" hint is shown.
const BLUR_HINT_AFTER_MS = 2500
const BLUR_THRESHOLD = 40

export default function ScannerPage({ lang }: ScannerPageProps) {
  const videoRef   = useRef<HTMLVideoElement>(null)
  const canvasRef  = useRef<HTMLCanvasElement>(null)   // hidden, used to read frames
  const overlayRef = useRef<HTMLCanvasElement>(null)   // visible, used to draw corners
  const streamRef  = useRef<MediaStream | null>(null)
  const rafRef     = useRef<number | null>(null)
  // lastIdRef: avoids the stale-closure problem in the RAF loop.
  // The state (lastId) is only for UI rendering; checks use the ref.
  const lastIdRef  = useRef<number | null>(null)
  // detectingRef: don't start a new detection while one is running (prevents
  // main-thread pile-up — the video stays smooth).
  const detectingRef = useRef(false)
  // recentIdsRef: detected IDs of the latest frames (-1 when none). Used for voting.
  const recentIdsRef = useRef<number[]>([])
  // allowedIdsRef: marker IDs registered in the DB. Only IDs in this set are
  // accepted — misreads such as "136" instead of "1" in a dense dictionary are
  // rejected (because they aren't registered). If the set is empty (no parts), no filter is applied.
  const allowedIdsRef = useRef<Set<number>>(new Set())
  // scanStartRef: start time of this scan round (performance.now).
  const scanStartRef = useRef(0)
  // scanTimedOutRef: 15 s passed with no lock → kept as a ref (alongside the state)
  // to avoid the stale-closure problem in the RAF loop.
  const scanTimedOutRef = useRef(false)
  // roiRef: expanded bbox of the last successful detection — scanned first in
  // the following frames (fast path). misses counts towards falling back to the full frame.
  const roiRef = useRef<(RoiHint & { misses: number }) | null>(null)
  // lastDetectAtRef: detection rate limit (MIN_DETECT_INTERVAL_MS)
  const lastDetectAtRef = useRef(0)
  // blurCounterRef: sharpness is measured occasionally, not on every frame
  const blurCounterRef = useRef(0)

  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [foundPart, setFoundPart] = useState<Part | null | undefined>(undefined)
  const [lastId, setLastId] = useState<number | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanTimedOut, setScanTimedOut] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [cvStatus, setCvStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [blurry, setBlurry] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [zoomCaps, setZoomCaps] = useState<{ min: number; max: number; step: number } | null>(null)
  const [zoom, setZoom] = useState(1)

  const t = lang === 'TR'
    ? {
        title:      'ArUco Kamera Tarayıcı',
        desc:       'Kameranızı ArUco kodlu parçanın üzerine tutun.',
        start:      '📷 Kamerayı Başlat',
        stop:       '⏹ Durdur',
        placeholder:'Parçayı sarı kutu içine getirin',
        noCamera:   'Kamera erişimi reddedildi veya bulunamadı.',
        found:      '✅ Parça Bulundu',
        name:       'Ad:',
        mat:        'Malzeme:',
        notes:      'Notlar:',
        date:       'Tarih:',
        notFound:   'Bu ID veritabanında kayıtlı değil.',
        scanNew:    '🔄 Yeni Tara',
        detected:   'Tespit edildi — ID',
        scanning:   'Taranıyor…',
        camOff:     'Kamera kapalı',
        timeout:    '⚠️ 15 saniyede marker bulunamadı. Işığı/açıyı değiştirip tekrar deneyin.',
        engineError:'ArUco motoru yüklenemedi:',
        cvLoading:  'Gelişmiş motor yükleniyor…',
        cvReady:    'Gelişmiş motor aktif (OpenCV)',
        cvFailed:   'Temel motor (OpenCV yüklenemedi)',
        blurryHint: '🔍 Görüntü bulanık görünüyor — parçayı kameranın odak mesafesine getirin (webcamlerde ~15-25 cm).',
        torch:      '🔦 Işık',
        zoomLabel:  'Yakınlaştırma',
      }
    : {
        title:      'ArUco Camera Scanner',
        desc:       'Point the camera at a part with an ArUco code.',
        start:      '📷 Start Camera',
        stop:       '⏹ Stop',
        placeholder:'Place the part inside the yellow box',
        noCamera:   'Camera access denied or not found.',
        found:      '✅ Part Found',
        name:       'Name:',
        mat:        'Material:',
        notes:      'Notes:',
        date:       'Date:',
        notFound:   'This ID is not registered in the database.',
        scanNew:    '🔄 Scan New',
        detected:   'Detected — ID',
        scanning:   'Scanning…',
        camOff:     'Camera off',
        timeout:    '⚠️ No marker found in 15 seconds. Adjust lighting/angle and try again.',
        engineError:'Failed to load ArUco engine:',
        cvLoading:  'Enhanced engine loading…',
        cvReady:    'Enhanced engine active (OpenCV)',
        cvFailed:   'Basic engine (OpenCV failed to load)',
        blurryHint: '🔍 Image looks blurry — move the part to your camera\'s focus distance (~15-25 cm for webcams).',
        torch:      '🔦 Torch',
        zoomLabel:  'Zoom',
      }

  // ─── Camera ────────────────────────────────────────────────────────────────

  const startCamera = async () => {
    setCameraError(null)
    setFoundPart(undefined)
    setLastId(null)
    lastIdRef.current = null
    recentIdsRef.current = []
    // Fetch the registered marker IDs from the DB — only these will be accepted
    try {
      const parts = await getAllParts()
      allowedIdsRef.current = new Set(parts.map((p) => p.markerId))
    } catch {
      allowedIdsRef.current = new Set()
    }
    try {
      // Ask for 1080p: the OpenCV path handles high resolution, and pixels per
      // cell are critical for small (10 mm) markers. If the camera can't deliver,
      // the browser picks the closest mode.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      streamRef.current = stream

      // ── Camera capabilities: continuous focus + torch + zoom ──
      // The standard TS types don't include torch/zoom/focusMode → any.
      const track = stream.getVideoTracks()[0] as any
      try {
        const caps = track.getCapabilities?.() ?? {}
        // Continuous autofocus — for sharpness at close range (on cameras that
        // support it; failures are silently ignored)
        if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
          track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {})
        }
        setTorchSupported(caps.torch === true)
        setTorchOn(false)
        if (caps.zoom && typeof caps.zoom.min === 'number' && caps.zoom.max > caps.zoom.min) {
          setZoomCaps({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 })
          setZoom(track.getSettings?.()?.zoom ?? caps.zoom.min)
        } else {
          setZoomCaps(null)
        }
      } catch { /* capabilities unreadable — the controls stay hidden */ }

      // Start the scan clock once the camera is ready
      scanStartRef.current = performance.now()
      scanTimedOutRef.current = false
      roiRef.current = null
      lastDetectAtRef.current = 0
      setBlurry(false)
      setScanTimedOut(false)
      setCameraActive(true)
    } catch {
      setCameraError(t.noCamera)
    }
  }

  /** Toggle the torch — on cameras that support it. */
  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0] as any
    if (!track) return
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] })
      setTorchOn(v => !v)
    } catch { /* not supported */ }
  }

  /** Apply optical/digital zoom — on cameras that support it. */
  const applyZoom = (v: number) => {
    setZoom(v)
    const track = streamRef.current?.getVideoTracks()[0] as any
    track?.applyConstraints?.({ advanced: [{ zoom: v }] }).catch(() => {})
  }

  const stopCamera = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    // Clear the overlay
    const ol = overlayRef.current
    if (ol) ol.getContext('2d')?.clearRect(0, 0, ol.width, ol.height)
    recentIdsRef.current = []
    scanTimedOutRef.current = false
    roiRef.current = null
    setBlurry(false)
    setTorchSupported(false)
    setTorchOn(false)
    setZoomCaps(null)
    setScanTimedOut(false)
    setCameraActive(false)
    setScanning(false)
  }, [])

  // Preload the aruco scripts when the page mounts.
  // If loading fails (e.g. a script 404s), don't fail silently — report it in the UI.
  useEffect(() => {
    preloadAruco()
      .then(() => setEngineError(null))
      .catch((e) => setEngineError(String(e?.message ?? e)))
  }, [])

  // Track the OpenCV engine status (loading continues in the background) — for the chip.
  useEffect(() => {
    if (openCVStatus() !== 'loading') { setCvStatus(openCVStatus()); return }
    const iv = setInterval(() => {
      const s = openCVStatus()
      setCvStatus(s)
      if (s !== 'loading') clearInterval(iv)
    }, 500)
    return () => clearInterval(iv)
  }, [])

  // Clean up when the camera stops
  useEffect(() => () => stopCamera(), [stopCamera])

  // ─── Detection loop ────────────────────────────────────────────────────────

  const handleDetection = useCallback(async (id: number) => {
    if (id === lastIdRef.current) return  // skip when the same ID arrives again — the ref avoids stale closures
    lastIdRef.current = id
    setLastId(id)
    setScanning(false)
    const part = await getPartByMarkerId(id)
    setFoundPart(part ?? null)
  }, [])

  const detectionLoop = useCallback(() => {
    const video   = videoRef.current
    const canvas  = canvasRef.current
    const overlay = overlayRef.current
    if (!video || !canvas || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(detectionLoop)
      return
    }

    const w = video.videoWidth
    const h = video.videoHeight
    if (w === 0 || h === 0) {
      rafRef.current = requestAnimationFrame(detectionLoop)
      return
    }

    // Skip this frame if the previous detection is still running, if we hit the
    // rate limit, OR if the scan has timed out
    const now = performance.now()
    if (
      !detectingRef.current &&
      !scanTimedOutRef.current &&
      now - lastDetectAtRef.current >= MIN_DETECT_INTERVAL_MS
    ) {
      detectingRef.current = true
      lastDetectAtRef.current = now

      canvas.width  = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(video, 0, 0, w, h)
      const imageData = ctx.getImageData(0, 0, w, h)

      // ROI hint: if a marker was found in the previous frame, that region is scanned first
      const roi = roiRef.current

      // Async detection — the RAF loop isn't blocked
      detectMarkers(imageData, roi).then((markers) => {
        // ── Candidate selection ──
        // The engine now returns ALL candidates (mirrored + normal, all variants).
        // A textured background can produce false squares; if a registered ID is
        // present, prefer it — so a false candidate can't shadow the real marker.
        const allowedSet = allowedIdsRef.current
        const chosen =
          markers.find(m => allowedSet.size === 0 || allowedSet.has(m.id)) ??
          markers[0] ?? null

        // ── Update ROI tracking ──
        if (chosen) {
          const xs = chosen.corners.map(c => c.x)
          const ys = chosen.corners.map(c => c.y)
          const bx = Math.min(...xs), by = Math.min(...ys)
          const bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by
          const mx = (bw * (ROI_EXPAND - 1)) / 2
          const my = (bh * (ROI_EXPAND - 1)) / 2
          roiRef.current = { x: bx - mx, y: by - my, w: bw + 2 * mx, h: bh + 2 * my, misses: 0 }
          if (blurCounterRef.current !== 0) blurCounterRef.current = 0
          setBlurry(false)
        } else if (roiRef.current) {
          roiRef.current.misses++
          if (roiRef.current.misses > ROI_MAX_MISSES) roiRef.current = null
        }

        // ── Blur hint ──
        // If no marker has been seen for a while, check sharpness now and then (every ~15
        // detections); if it's low, show the user a focus-distance hint.
        if (!chosen && lastIdRef.current === null) {
          const elapsed = performance.now() - scanStartRef.current
          if (elapsed > BLUR_HINT_AFTER_MS && ++blurCounterRef.current >= 15) {
            blurCounterRef.current = 0
            setBlurry(estimateSharpness(imageData) < BLUR_THRESHOLD)
          }
        }
        // Match the overlay size to the video
        if (overlay && (overlay.width !== w || overlay.height !== h)) {
          overlay.width  = w
          overlay.height = h
        }

        // ── Registered-ID filter ──
        // rawId: the chosen candidate's ID. Only IDs registered in the DB are valid
        // (empty set → no filter, everything is valid). Unregistered reads enter
        // the buffer as -1 and are never counted.
        const allowed = allowedSet
        const rawId = chosen ? chosen.id : -1
        const accepted = rawId >= 0 && (allowed.size === 0 || allowed.has(rawId))

        // ── Update the voting buffer ──
        // The buffer is kept as long as the largest window (strict phase); counting
        // uses the active phase's window.
        const buf = recentIdsRef.current
        buf.push(accepted ? rawId : -1)
        if (buf.length > VOTE_STRICT.window) buf.shift()

        // Already locked? (box is green for a confirmed detection, otherwise yellow = candidate)
        const confirmed = lastIdRef.current !== null

        if (overlay) {
          const octx = overlay.getContext('2d')!
          octx.clearRect(0, 0, w, h)

          if (chosen) {
            const m = chosen
            // The video is mirrored horizontally via CSS (for natural control). Corners
            // arrive in raw frame space, so flip x to line up with the mirrored video.
            // The text overlay is not mirrored, so it stays readable.
            const fx = (x: number) => w - x
            // Green: confirmed · Yellow: valid candidate · Red: not registered (rejected)
            const color = confirmed ? '#22c55e' : accepted ? '#eab308' : '#ef4444'
            octx.strokeStyle = color
            octx.lineWidth   = Math.max(2, w / 200)
            octx.beginPath()
            octx.moveTo(fx(m.corners[0].x), m.corners[0].y)
            for (let i = 1; i < m.corners.length; i++) {
              octx.lineTo(fx(m.corners[i].x), m.corners[i].y)
            }
            octx.closePath()
            octx.stroke()

            // ID label
            octx.fillStyle = color
            octx.font      = `bold ${Math.max(14, w / 40)}px monospace`
            octx.fillText(`ID: ${m.id}`, fx(m.corners[0].x) + 4, m.corners[0].y - 6)
          }
        }

        // ── Lock / timeout decision ──
        // Only runs while not yet locked.
        if (lastIdRef.current === null && !scanTimedOutRef.current) {
          const elapsed = performance.now() - scanStartRef.current

          if (elapsed >= GIVEUP_AFTER_MS) {
            // 15 s passed and still no lock → not found
            scanTimedOutRef.current = true
            setScanTimedOut(true)
            setScanning(false)
          } else {
            // Strict for the first RELAX_AFTER_MS (4 of 7), relaxed afterwards (2 of 4)
            const phase = elapsed < RELAX_AFTER_MS ? VOTE_STRICT : VOTE_RELAXED
            const recent = buf.slice(Math.max(0, buf.length - phase.window))
            const counts = new Map<number, number>()
            for (const v of recent) {
              if (v >= 0) counts.set(v, (counts.get(v) ?? 0) + 1)
            }
            let bestId = -1
            let bestCount = 0
            for (const [id, c] of counts) {
              if (c > bestCount) { bestId = id; bestCount = c }
            }
            if (bestId >= 0 && bestCount >= phase.min) {
              handleDetection(bestId)
            }
          }
        }
      }).finally(() => {
        detectingRef.current = false
      })
    }

    rafRef.current = requestAnimationFrame(detectionLoop)
  }, [handleDetection])

  // Start/stop the loop while the camera is active
  useEffect(() => {
    if (cameraActive) {
      setScanning(true)
      rafRef.current = requestAnimationFrame(detectionLoop)
    } else {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [cameraActive, detectionLoop])

  // ─── New scan ──────────────────────────────────────────────────────────────

  const resetScan = () => {
    lastIdRef.current = null
    recentIdsRef.current = []
    scanStartRef.current = performance.now()
    scanTimedOutRef.current = false
    roiRef.current = null
    blurCounterRef.current = 0
    setBlurry(false)
    setScanTimedOut(false)
    setFoundPart(undefined)
    setLastId(null)
    setScanning(true)
    // Clear the overlay
    const ol = overlayRef.current
    if (ol) ol.getContext('2d')?.clearRect(0, 0, ol.width, ol.height)
  }

  // ─── UI ────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
      <h2 className="text-lg font-semibold text-neutral-100">{t.title}</h2>
      <p className="text-sm text-neutral-500">{t.desc}</p>

      {/* Engine load error — make a silent failure visible */}
      {engineError && (
        <div className="text-sm px-4 py-2.5 rounded-xl border bg-red-950/40 border-red-900 text-red-400">
          {t.engineError} <span className="font-mono text-xs">{engineError}</span>
        </div>
      )}

      {/* Advanced engine (OpenCV) status */}
      <div className="flex items-center gap-2 text-xs">
        <span className={`w-2 h-2 rounded-full ${
          cvStatus === 'ready' ? 'bg-green-400' : cvStatus === 'loading' ? 'bg-yellow-400 animate-pulse' : 'bg-neutral-500'
        }`} />
        <span className={cvStatus === 'ready' ? 'text-green-400' : 'text-neutral-500'}>
          {cvStatus === 'ready' ? t.cvReady : cvStatus === 'loading' ? t.cvLoading : t.cvFailed}
        </span>
      </div>

      {/* Video + overlay */}
      <div
        className="relative rounded-xl overflow-hidden border border-neutral-800 bg-neutral-900"
        style={{ aspectRatio: '16/9' }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          className="w-full h-full object-cover"
          style={{ transform: 'scaleX(-1)' }}  /* natural mirror view — easier to control */
        />

        {/* Overlay canvas that draws the detected corners */}
        <canvas
          ref={overlayRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ objectFit: 'cover' }}
        />

        {/* Target box (only while scanning and before any detection) */}
        {cameraActive && scanning && foundPart === undefined && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-2">
            <div className="w-44 h-44 border-2 border-yellow-400 rounded-lg" />
            <span className="text-yellow-400 text-xs">{t.placeholder}</span>
          </div>
        )}

        {/* Camera off */}
        {!cameraActive && (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-sm">
            {cameraError ?? t.camOff}
          </div>
        )}

        {/* Scanning indicator */}
        {cameraActive && scanning && foundPart === undefined && (
          <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/60 rounded-full px-3 py-1">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs text-green-400">{t.scanning}</span>
          </div>
        )}
      </div>

      {/* Hidden frame canvas */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Control buttons */}
      <div className="flex gap-3 flex-wrap">
        {!cameraActive ? (
          <button
            onClick={startCamera}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium"
          >
            {t.start}
          </button>
        ) : (
          <>
            <button
              onClick={stopCamera}
              className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white rounded-lg text-sm font-medium"
            >
              {t.stop}
            </button>
            {lastId !== null && (
              <button
                onClick={resetScan}
                className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white rounded-lg text-sm font-medium"
              >
                {t.scanNew}
              </button>
            )}
            {torchSupported && (
              <button
                onClick={toggleTorch}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${
                  torchOn ? 'bg-yellow-600 hover:bg-yellow-500 text-black' : 'bg-neutral-700 hover:bg-neutral-600 text-white'
                }`}
              >
                {t.torch}
              </button>
            )}
            {zoomCaps && (
              <label className="flex items-center gap-2 text-xs text-neutral-400">
                {t.zoomLabel}
                <input
                  type="range"
                  min={zoomCaps.min}
                  max={zoomCaps.max}
                  step={zoomCaps.step}
                  value={zoom}
                  onChange={(e) => applyZoom(parseFloat(e.target.value))}
                  className="w-28 accent-blue-500 cursor-pointer"
                />
              </label>
            )}
          </>
        )}
      </div>

      {/* Blur hint */}
      {cameraActive && blurry && lastId === null && !scanTimedOut && (
        <div className="text-sm px-4 py-2.5 rounded-xl border bg-sky-950/40 border-sky-900 text-sky-300">
          {t.blurryHint}
        </div>
      )}

      {/* Timeout — no lock within 15 s */}
      {scanTimedOut && (
        <div className="bg-neutral-900 border border-amber-900 rounded-xl p-4 space-y-3">
          <p className="text-amber-400 text-sm">{t.timeout}</p>
          <button
            onClick={resetScan}
            className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-white rounded-lg text-sm font-medium"
          >
            {t.scanNew}
          </button>
        </div>
      )}

      {/* Detection result */}
      {lastId !== null && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-3">
          <p className="text-xs text-neutral-500 uppercase tracking-wider">
            {t.detected} {lastId}
          </p>

          {foundPart === undefined && (
            <p className="text-neutral-400 text-sm animate-pulse">…</p>
          )}

          {foundPart !== null && foundPart !== undefined && (
            <div className="space-y-1 text-sm">
              <p className="text-green-400 font-semibold">{t.found}</p>
              <p className="text-neutral-300">
                {t.name} <span className="text-white">{foundPart.name}</span>
              </p>
              <p className="text-neutral-300">
                {t.mat} <span className="text-white">{foundPart.material}</span>
              </p>
              {foundPart.notes && (
                <p className="text-neutral-300">
                  {t.notes} <span className="text-white">{foundPart.notes}</span>
                </p>
              )}
              <p className="text-neutral-500 text-xs">
                {t.date} {new Date(foundPart.createdAt).toLocaleString()}
              </p>
            </div>
          )}

          {foundPart === null && (
            <p className="text-neutral-500 text-sm">{t.notFound}</p>
          )}
        </div>
      )}
    </div>
  )
}

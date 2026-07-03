/**
 * Kamera tarayıcı sayfası.
 * js-aruco2 ile tarayıcı taraflı ARUCO_4X4_50 tespiti yapar.
 * Telefon arka kamerasını (facingMode: environment) otomatik tercih eder.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getPartByMarkerId, getAllParts } from '../lib/db'
import { detectMarkers, preloadAruco, estimateSharpness, type RoiHint } from '../lib/aruco-scanner'
import { openCVStatus } from '../lib/aruco-opencv'
import type { Part } from '../lib/db'

interface ScannerPageProps {
  lang: 'TR' | 'EN'
}

// ── Kare-bazlı oylama — zaman kademeli ──────────────────────────────────────
// İlk RELAX_AFTER_MS boyunca SIKI eşikle (yüksek güven) kilit ararız. O sürede
// bulunamazsa GEVŞEK eşiğe düşer, denemeye devam ederiz. Toplam GIVEUP_AFTER_MS
// dolduğunda hâlâ kilit yoksa "bulunamadı" gösterilir.
// Not: her eşik "son N karenin en az M'i" demek. Tampon en büyük pencere kadar
// tutulur; sayım o anki fazın penceresi üzerinden yapılır.
const VOTE_STRICT   = { window: 7, min: 4 }
const VOTE_RELAXED  = { window: 4, min: 2 }
const RELAX_AFTER_MS  = 3000   // 3 sn sonra gevşe
const GIVEUP_AFTER_MS = 15000  // 15 sn sonra bulunamadı

// Tespit hızı sınırı: RAF 60fps çalışır ama tespit (özellikle OpenCV +
// varyant matrisi) her karede gerekmez; ~10fps yeterli ve ana iş parçacığını
// rahatlatır — video ve overlay akıcı kalır.
const MIN_DETECT_INTERVAL_MS = 100

// ROI takibi: marker bulununca bbox bu çarpanla genişletilip sonraki
// karelerde önce yalnız o bölge taranır. Üst üste bu kadar kaçırmada tam
// kareye dönülür.
const ROI_EXPAND = 1.8
const ROI_MAX_MISSES = 10

// Bulanıklık: marker bu süredir yoksa ve Laplacian varyansı eşiğin
// altındaysa "bulanık" ipucu gösterilir.
const BLUR_HINT_AFTER_MS = 2500
const BLUR_THRESHOLD = 40

export default function ScannerPage({ lang }: ScannerPageProps) {
  const videoRef   = useRef<HTMLVideoElement>(null)
  const canvasRef  = useRef<HTMLCanvasElement>(null)   // gizli, frame okumak için
  const overlayRef = useRef<HTMLCanvasElement>(null)   // görünür, köşe çizmek için
  const streamRef  = useRef<MediaStream | null>(null)
  const rafRef     = useRef<number | null>(null)
  // lastIdRef: RAF döngüsündeki stale closure sorununu önler.
  // State (lastId) sadece UI render için; kontrol ref ile yapılır.
  const lastIdRef  = useRef<number | null>(null)
  // detectingRef: bir tespit devam ederken yenisini başlatma (ana iş parçacığı
  // yığılmasını önler — video akıcı kalır).
  const detectingRef = useRef(false)
  // recentIdsRef: son karelerin tespit ID'leri (tespit yoksa -1). Oylama için.
  const recentIdsRef = useRef<number[]>([])
  // allowedIdsRef: DB'de kayıtlı marker ID'leri. Yalnızca bu kümedeki ID'ler
  // kabul edilir — yoğun sözlükte "1" yerine "136" gibi kayıp okumalar (kayıtlı
  // olmadıkları için) reddedilir. Küme boşsa (hiç parça yok) filtre uygulanmaz.
  const allowedIdsRef = useRef<Set<number>>(new Set())
  // scanStartRef: bu tarama turunun başlangıç zamanı (performance.now).
  const scanStartRef = useRef(0)
  // scanTimedOutRef: 15 sn doldu ve kilit yok → RAF döngüsündeki stale closure
  // sorununu önlemek için ref (state ile birlikte tutulur).
  const scanTimedOutRef = useRef(false)
  // roiRef: son başarılı tespitin genişletilmiş bbox'ı — sonraki karelerde
  // önce burası taranır (hızlı yol). misses ile tam kareye dönüş sayılır.
  const roiRef = useRef<(RoiHint & { misses: number }) | null>(null)
  // lastDetectAtRef: tespit hız sınırı (MIN_DETECT_INTERVAL_MS)
  const lastDetectAtRef = useRef(0)
  // blurCounterRef: keskinlik ölçümü her karede değil, seyrek yapılır
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

  // ─── Kamera ────────────────────────────────────────────────────────────────

  const startCamera = async () => {
    setCameraError(null)
    setFoundPart(undefined)
    setLastId(null)
    lastIdRef.current = null
    recentIdsRef.current = []
    // Kayıtlı marker ID'lerini DB'den çek — yalnızca bunlar kabul edilecek
    try {
      const parts = await getAllParts()
      allowedIdsRef.current = new Set(parts.map((p) => p.markerId))
    } catch {
      allowedIdsRef.current = new Set()
    }
    try {
      // 1080p iste: OpenCV yolu yüksek çözünürlüğü kaldırıyor ve küçük
      // (10mm) markerlarda hücre başına piksel kritik. Kamera veremezse
      // tarayıcı en yakın modu seçer.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      streamRef.current = stream

      // ── Kamera yetenekleri: sürekli odak + torch + zoom ──
      // Standart TS tipleri torch/zoom/focusMode içermez → any.
      const track = stream.getVideoTracks()[0] as any
      try {
        const caps = track.getCapabilities?.() ?? {}
        // Sürekli otomatik odak — yakın mesafede netlik için (destekleyen
        // kameralarda; başarısızlık sessizce yutulur)
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
      } catch { /* yetenek okunamadı — kontroller gizli kalır */ }

      // Tarama saatini kamera hazır olduğunda başlat
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

  /** Torch (fener) aç/kapa — destekleyen kameralarda. */
  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0] as any
    if (!track) return
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] })
      setTorchOn(v => !v)
    } catch { /* desteklenmiyor */ }
  }

  /** Optik/dijital zoom uygula — destekleyen kameralarda. */
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
    // Overlay'i temizle
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

  // Sayfa mount olunca aruco scriptlerini ön-yükle.
  // Yükleme başarısız olursa (örn. script 404) sessiz kalma — UI'da bildir.
  useEffect(() => {
    preloadAruco()
      .then(() => setEngineError(null))
      .catch((e) => setEngineError(String(e?.message ?? e)))
  }, [])

  // OpenCV motor durumunu izle (yükleme arka planda sürer) — chip için.
  useEffect(() => {
    if (openCVStatus() !== 'loading') { setCvStatus(openCVStatus()); return }
    const iv = setInterval(() => {
      const s = openCVStatus()
      setCvStatus(s)
      if (s !== 'loading') clearInterval(iv)
    }, 500)
    return () => clearInterval(iv)
  }, [])

  // Kamera durduğunda temizle
  useEffect(() => () => stopCamera(), [stopCamera])

  // ─── Tespit döngüsü ────────────────────────────────────────────────────────

  const handleDetection = useCallback(async (id: number) => {
    if (id === lastIdRef.current) return  // aynı ID tekrar gelince atla — ref ile stale closure yok
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

    // Bir önceki tespit sürüyorsa, hız sınırına takıldıysak VEYA zaman
    // aşımına düşüldüyse bu kareyi atla
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

      // ROI ipucu: önceki karede marker bulunduysa önce o bölge taranır
      const roi = roiRef.current

      // Async detection — RAF döngüsü bloklanmaz
      detectMarkers(imageData, roi).then((markers) => {
        // ── ROI takibini güncelle ──
        if (markers.length > 0) {
          const xs = markers[0].corners.map(c => c.x)
          const ys = markers[0].corners.map(c => c.y)
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

        // ── Bulanıklık ipucu ──
        // Marker bir süredir yoksa arada bir keskinliğe bak (her ~15 tespit);
        // düşükse kullanıcıya odak mesafesi ipucu göster.
        if (markers.length === 0 && lastIdRef.current === null) {
          const elapsed = performance.now() - scanStartRef.current
          if (elapsed > BLUR_HINT_AFTER_MS && ++blurCounterRef.current >= 15) {
            blurCounterRef.current = 0
            setBlurry(estimateSharpness(imageData) < BLUR_THRESHOLD)
          }
        }
        // Overlay boyutunu video ile eşitle
        if (overlay && (overlay.width !== w || overlay.height !== h)) {
          overlay.width  = w
          overlay.height = h
        }

        // ── Kayıtlı ID filtresi ──
        // rawId: motorun okuduğu ham ID. Yalnızca DB'de kayıtlı ID'ler geçerli
        // (küme boşsa filtre yok → hepsi geçerli). Kayıtlı olmayan okumalar
        // (yoğun sözlükte "1"→"136" gibi) tampona -1 olarak girer, hiç sayılmaz.
        const allowed = allowedIdsRef.current
        const rawId = markers.length > 0 ? markers[0].id : -1
        const accepted = rawId >= 0 && (allowed.size === 0 || allowed.has(rawId))

        // ── Oylama tamponunu güncelle ──
        // Tampon en büyük pencere (sıkı faz) kadar tutulur; sayım aktif fazın
        // penceresi üzerinden yapılır.
        const buf = recentIdsRef.current
        buf.push(accepted ? rawId : -1)
        if (buf.length > VOTE_STRICT.window) buf.shift()

        // Zaten kilitli miyiz? (onaylanmış tespit varsa kutu yeşil, yoksa sarı=aday)
        const confirmed = lastIdRef.current !== null

        if (overlay) {
          const octx = overlay.getContext('2d')!
          octx.clearRect(0, 0, w, h)

          if (markers.length > 0) {
            const m = markers[0]
            // Video CSS ile yatay aynalanıyor (doğal kontrol için). Köşeler ham
            // kare uzayında geldiğinden, aynalı video ile hizalamak için x'i çevir.
            // Metin overlay aynalanmadığından okunur kalır.
            const fx = (x: number) => w - x
            // Yeşil: onaylı · Sarı: geçerli aday · Kırmızı: kayıtlı değil (reddedildi)
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

            // ID etiketi
            octx.fillStyle = color
            octx.font      = `bold ${Math.max(14, w / 40)}px monospace`
            octx.fillText(`ID: ${m.id}`, fx(m.corners[0].x) + 4, m.corners[0].y - 6)
          }
        }

        // ── Kilitleme / zaman aşımı kararı ──
        // Yalnızca henüz kilitli değilken çalışır.
        if (lastIdRef.current === null && !scanTimedOutRef.current) {
          const elapsed = performance.now() - scanStartRef.current

          if (elapsed >= GIVEUP_AFTER_MS) {
            // 15 sn doldu, hâlâ kilit yok → bulunamadı
            scanTimedOutRef.current = true
            setScanTimedOut(true)
            setScanning(false)
          } else {
            // İlk RELAX_AFTER_MS sıkı (7/4), sonrası gevşek (4/2)
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

  // Kamera aktif olduğunda döngüyü başlat/durdur
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

  // ─── Yeni tarama ───────────────────────────────────────────────────────────

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
    // Overlay temizle
    const ol = overlayRef.current
    if (ol) ol.getContext('2d')?.clearRect(0, 0, ol.width, ol.height)
  }

  // ─── UI ────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
      <h2 className="text-lg font-semibold text-neutral-100">{t.title}</h2>
      <p className="text-sm text-neutral-500">{t.desc}</p>

      {/* Motor yükleme hatası — sessiz başarısızlığı görünür kıl */}
      {engineError && (
        <div className="text-sm px-4 py-2.5 rounded-xl border bg-red-950/40 border-red-900 text-red-400">
          {t.engineError} <span className="font-mono text-xs">{engineError}</span>
        </div>
      )}

      {/* Gelişmiş motor (OpenCV) durumu */}
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
          style={{ transform: 'scaleX(-1)' }}  /* doğal ayna görünümü — kontrol kolaylığı */
        />

        {/* Tespit köşelerini çizen overlay canvas */}
        <canvas
          ref={overlayRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ objectFit: 'cover' }}
        />

        {/* Hedef kutu (sadece taranıyor durumunda ve henüz tespit yokken) */}
        {cameraActive && scanning && foundPart === undefined && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-2">
            <div className="w-44 h-44 border-2 border-yellow-400 rounded-lg" />
            <span className="text-yellow-400 text-xs">{t.placeholder}</span>
          </div>
        )}

        {/* Kamera kapalı */}
        {!cameraActive && (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-sm">
            {cameraError ?? t.camOff}
          </div>
        )}

        {/* Taranıyor göstergesi */}
        {cameraActive && scanning && foundPart === undefined && (
          <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/60 rounded-full px-3 py-1">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs text-green-400">{t.scanning}</span>
          </div>
        )}
      </div>

      {/* Gizli frame canvas */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Kontrol butonları */}
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

      {/* Bulanıklık ipucu */}
      {cameraActive && blurry && lastId === null && !scanTimedOut && (
        <div className="text-sm px-4 py-2.5 rounded-xl border bg-sky-950/40 border-sky-900 text-sky-300">
          {t.blurryHint}
        </div>
      )}

      {/* Zaman aşımı — 15 sn'de kilit yok */}
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

      {/* Tespit sonucu */}
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

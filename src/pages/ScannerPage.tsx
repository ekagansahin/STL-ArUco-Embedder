/**
 * Kamera tarayıcı sayfası.
 * js-aruco2 ile tarayıcı taraflı ARUCO_4X4_1000 tespiti yapar.
 * Telefon arka kamerasını (facingMode: environment) otomatik tercih eder.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getPartByMarkerId } from '../lib/db'
import { detectMarkers, preloadAruco } from '../lib/aruco-scanner'
import type { Part } from '../lib/db'

interface ScannerPageProps {
  lang: 'TR' | 'EN'
}

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

  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [foundPart, setFoundPart] = useState<Part | null | undefined>(undefined)
  const [lastId, setLastId] = useState<number | null>(null)
  const [scanning, setScanning] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)

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
        engineError:'ArUco motoru yüklenemedi:',
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
        engineError:'Failed to load ArUco engine:',
      }

  // ─── Kamera ────────────────────────────────────────────────────────────────

  const startCamera = async () => {
    setCameraError(null)
    setFoundPart(undefined)
    setLastId(null)
    lastIdRef.current = null
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      streamRef.current = stream
      setCameraActive(true)
    } catch {
      setCameraError(t.noCamera)
    }
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

    // Bir önceki tespit hâlâ sürüyorsa bu kareyi atla (yığılmayı önle)
    if (!detectingRef.current) {
      detectingRef.current = true

      canvas.width  = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(video, 0, 0, w, h)
      const imageData = ctx.getImageData(0, 0, w, h)

      // Async detection — RAF döngüsü bloklanmaz
      detectMarkers(imageData).then((markers) => {
        // Overlay boyutunu video ile eşitle
        if (overlay && (overlay.width !== w || overlay.height !== h)) {
          overlay.width  = w
          overlay.height = h
        }

        if (overlay) {
          const octx = overlay.getContext('2d')!
          octx.clearRect(0, 0, w, h)

          if (markers.length > 0) {
            const m = markers[0]
            // Video CSS ile yatay aynalanıyor (doğal kontrol için). Köşeler ham
            // kare uzayında geldiğinden, aynalı video ile hizalamak için x'i çevir.
            // Metin overlay aynalanmadığından okunur kalır.
            const fx = (x: number) => w - x
            octx.strokeStyle = '#22c55e'
            octx.lineWidth   = Math.max(2, w / 200)
            octx.beginPath()
            octx.moveTo(fx(m.corners[0].x), m.corners[0].y)
            for (let i = 1; i < m.corners.length; i++) {
              octx.lineTo(fx(m.corners[i].x), m.corners[i].y)
            }
            octx.closePath()
            octx.stroke()

            // ID etiketi
            octx.fillStyle = '#22c55e'
            octx.font      = `bold ${Math.max(14, w / 40)}px monospace`
            octx.fillText(`ID: ${m.id}`, fx(m.corners[0].x) + 4, m.corners[0].y - 6)

            handleDetection(m.id)
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
          </>
        )}
      </div>

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

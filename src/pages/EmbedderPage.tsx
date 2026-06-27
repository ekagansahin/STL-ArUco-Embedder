/**
 * Ana sayfa: STL yükle → preset seç → ayarla → göm → indir
 */

import { useState, useCallback, useRef } from 'react'
import * as THREE from 'three'
import UploadZone from '../components/UploadZone'
import PresetCards from '../components/PresetCards'
import Viewer3D from '../components/Viewer3D'
import Footprint2D from '../components/Footprint2D'
import PlacementControls from '../components/PlacementControls'
import { loadSTLFromBuffer, computePresets, embedAruco, type Preset } from '../lib/mesh'
import { exportSTL, geometryToSTLBuffer } from '../lib/export'
import { getNextMarkerId, savePart } from '../lib/db'

interface EmbedderPageProps {
  lang: 'TR' | 'EN'
  onEmbedComplete?: () => void
}

type Step = 'upload' | 'preset' | 'place' | 'processing' | 'done'

export default function EmbedderPage({ lang, onEmbedComplete }: EmbedderPageProps) {
  const [step, setStep] = useState<Step>('upload')
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null)
  const [, setFilename] = useState('')
  const [presets, setPresets] = useState<Preset[]>([])
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null)
  const [rotation, setRotation] = useState<[number, number, number]>([0, 0, 0])
  const [markerX, setMarkerX] = useState(0)
  const [markerY, setMarkerY] = useState(0)
  const [markerSize, setMarkerSize] = useState(15)
  const [etchDepth, setEtchDepth] = useState(0.6)
  const [partName, setPartName] = useState('')
  const [material, setMaterial] = useState('PLA')
  const [notes, setNotes] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [resultGeo, setResultGeo] = useState<THREE.BufferGeometry | null>(null)
  const markerIdRef       = useRef<number>(0)
  const originalBufferRef = useRef<ArrayBuffer | null>(null)
  const leftWidthRef      = useRef(520)
  const [leftWidth, setLeftWidth] = useState(520)

  const t = lang === 'TR'
    ? {
        title: 'ArUco Gömücü',
        uploadTitle: 'STL Yükle',
        presetTitle: 'Yerleşim Seç',
        placeTitle: 'Konumlandır',
        partInfo: 'Parça Bilgileri',
        partName: 'Parça Adı',
        material: 'Malzeme',
        notes: 'Notlar',
        generate: '✨ ArUco Göm ve İndir',
        processing: 'İşleniyor... (Manifold WASM)',
        success: '✅ Başarılı! İndirme başladı.',
        newPart: '+ Yeni STL Yükle',
        back: '← Geri',
        next: 'Devam →',
        confirm: 'Onayla ve Devam Et',
        outOfBounds: '⚠️ Marker mesh sınırı dışında — konumu düzelt',
      }
    : {
        title: 'ArUco Embedder',
        uploadTitle: 'Upload STL',
        presetTitle: 'Choose Placement',
        placeTitle: 'Position Marker',
        partInfo: 'Part Information',
        partName: 'Part Name',
        material: 'Material',
        notes: 'Notes',
        generate: '✨ Embed ArUco & Download',
        processing: 'Processing... (Manifold WASM)',
        success: '✅ Done! Download started.',
        newPart: '+ Upload New STL',
        back: '← Back',
        next: 'Continue →',
        confirm: 'Confirm & Continue',
        outOfBounds: '⚠️ Marker out of mesh bounds — adjust position',
      }

  const handleFile = useCallback(async (buffer: ArrayBuffer, name: string) => {
    setErrorMsg(null)
    originalBufferRef.current = buffer   // orijinal STL'yi sakla
    const geo = loadSTLFromBuffer(buffer)
    const computedPresets = computePresets(geo)
    const nextId = await getNextMarkerId()
    markerIdRef.current = nextId
    setGeometry(geo)
    setFilename(name)
    setPartName(name.replace(/\.stl$/i, ''))
    setPresets(computedPresets)
    setStep('preset')
  }, [])

  const handlePresetSelect = useCallback((preset: Preset) => {
    setSelectedPreset(preset.id)
    setRotation(preset.rotation)
    setMarkerX(preset.position[0])
    setMarkerY(preset.position[1])
    setMarkerSize(preset.markerSize)
    setEtchDepth(preset.etchDepth)
  }, [])

  const handleControlChange = useCallback((key: string, value: number) => {
    switch (key) {
      case 'rotX': setRotation(r => [value, r[1], r[2]]); break
      case 'rotY': setRotation(r => [r[0], value, r[2]]); break
      case 'rotZ': setRotation(r => [r[0], r[1], value]); break
      case 'markerX': setMarkerX(value); break
      case 'markerY': setMarkerY(value); break
      case 'markerSize': setMarkerSize(value); break
      case 'etchDepth': setEtchDepth(value); break
    }
    setSelectedPreset('custom')
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!geometry) return
    setStep('processing')
    setErrorMsg(null)
    try {
      const embedded = await embedAruco(geometry, {
        markerId: markerIdRef.current,
        rotation,
        position: [markerX, markerY],
        markerSize,
        etchDepth,
      })
      setResultGeo(embedded)
      const outName = `ID_${markerIdRef.current}_${partName.replace(/\s+/g, '_')}_PRINT_READY`
      const printReadyBuffer = geometryToSTLBuffer(embedded)
      exportSTL(embedded, outName)
      await savePart({
        markerId: markerIdRef.current,
        name: partName,
        material,
        notes,
        createdAt: new Date().toISOString(),
        filename: outName + '.stl',
        originalStl:   originalBufferRef.current ?? undefined,
        printReadyStl: printReadyBuffer,
      })
      onEmbedComplete?.()
      setStep('done')
    } catch (e: any) {
      setErrorMsg(String(e?.message ?? e))
      setStep('place')
    }
  }, [geometry, rotation, markerX, markerY, markerSize, etchDepth, partName, material, notes, onEmbedComplete])

  // ── Sol panel sürükle-bırak ─────────────────────────────────────────────
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    const startX    = e.clientX
    const startWidth = leftWidthRef.current
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(180, Math.min(540, startWidth + ev.clientX - startX))
      leftWidthRef.current = w
      setLeftWidth(w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }, [])

  const reset = useCallback(() => {
    originalBufferRef.current = null
    setStep('upload')
    setGeometry(null)
    setPresets([])
    setSelectedPreset(null)
    setRotation([0, 0, 0])
    setMarkerX(0); setMarkerY(0)
    setMarkerSize(15); setEtchDepth(0.6)
    setPartName(''); setMaterial('PLA'); setNotes('')
    setErrorMsg(null)
    setResultGeo(null)
  }, [])

  // ── Upload adımı ────────────────────────────────────────────────────────
  if (step === 'upload') {
    return (
      <div className="max-w-lg mx-auto mt-16 px-4">
        <h2 className="text-lg font-semibold text-neutral-100 mb-6">{t.uploadTitle}</h2>
        <UploadZone onFile={handleFile} lang={lang} />
      </div>
    )
  }

  // ── İşleniyor ───────────────────────────────────────────────────────────
  if (step === 'processing') {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-neutral-400 text-sm">{t.processing}</p>
      </div>
    )
  }

  // ── Bitti ───────────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <div className="max-w-lg mx-auto mt-6 px-4 text-center space-y-4">
        <div className="flex items-center justify-center gap-3">
          <span className="text-3xl">🎉</span>
          <p className="text-green-400 font-semibold">{t.success}</p>
        </div>
        <p className="text-neutral-400 text-sm">
          ArUco ID: <span className="font-mono text-white">{markerIdRef.current}</span>
        </p>
        {resultGeo && (
          <div style={{ maxHeight: 200, overflow: 'hidden' }}>
            <Viewer3D
              geometry={resultGeo}
              markerX={markerX} markerY={markerY}
              markerSize={markerSize} etchDepth={etchDepth}
              rotation={[0, 0, 0]}
            />
          </div>
        )}
        <button
          onClick={reset}
          className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium"
        >
          {t.newPart}
        </button>
      </div>
    )
  }

  // ── Preset + Place (tek ekran, step 'preset' veya 'place') ─────────────
  return (
    <div className="flex h-full p-4 overflow-hidden">

      {/* Sol panel — genişliği sürükle-bırak ile ayarlanır */}
      <div
        className="shrink-0 flex flex-col gap-4 overflow-y-auto"
        style={{ width: leftWidth }}
      >

        {/* Preset kartları */}
        <div className="bg-neutral-900 rounded-xl p-4 border border-neutral-800">
          <PresetCards
            presets={presets}
            selected={selectedPreset}
            onSelect={handlePresetSelect}
            lang={lang}
          />
        </div>

        {/* Kontroller */}
        {selectedPreset && (
          <div className="bg-neutral-900 rounded-xl p-4 border border-neutral-800">
            <PlacementControls
              rotation={rotation}
              markerX={markerX} markerY={markerY}
              markerSize={markerSize} etchDepth={etchDepth}
              bounds={geometry ? (() => {
                const g = geometry.clone()
                g.computeBoundingBox()
                const bb = g.boundingBox!
                return { minX: bb.min.x, maxX: bb.max.x, minY: bb.min.y, maxY: bb.max.y }
              })() : null}
              lang={lang}
              onChange={handleControlChange}
            />
          </div>
        )}

        {/* Parça bilgileri */}
        {selectedPreset && (
          <div className="bg-neutral-900 rounded-xl p-4 border border-neutral-800 space-y-3">
            <div className="text-xs text-neutral-500 uppercase tracking-wider">{t.partInfo}</div>
            <div className="text-xs text-neutral-500">
              ArUco ID: <span className="font-mono text-white">{markerIdRef.current}</span>
            </div>
            <input
              value={partName}
              onChange={(e) => setPartName(e.target.value)}
              placeholder={t.partName}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-blue-500"
            />
            <input
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
              placeholder={t.material}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-blue-500"
            />
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t.notes}
              rows={2}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-blue-500 resize-none"
            />
          </div>
        )}
      </div>

      {/* Sürüklenebilir ayırıcı */}
      <div
        onMouseDown={handleDividerMouseDown}
        className="shrink-0 w-3 mx-1 flex items-center justify-center cursor-col-resize group self-stretch"
      >
        <div className="w-px h-12 rounded-full bg-neutral-700 group-hover:bg-blue-500 transition-colors" />
      </div>

      {/* Sağ alan: 3D + 2D */}
      <div className="flex-1 flex flex-col gap-4 min-w-0">

        {/* 3D önizleme */}
        <div className="flex-1 relative rounded-xl overflow-hidden border border-neutral-800">
          <Viewer3D
            geometry={geometry}
            markerX={markerX} markerY={markerY}
            markerSize={markerSize} etchDepth={etchDepth}
            rotation={rotation}
          />
          <div className="absolute bottom-3 left-3 text-xs text-neutral-600 pointer-events-none">
            Sol tık: döndür · Sağ tık: kaydır · Scroll: zoom
          </div>
        </div>

        {/* 2D footprint */}
        {selectedPreset && (
          <Footprint2D
            geometry={geometry}
            rotation={rotation}
            markerX={markerX} markerY={markerY}
            markerSize={markerSize}
            lang={lang}
            onChange={(x, y) => { setMarkerX(x); setMarkerY(y); setSelectedPreset('custom') }}
          />
        )}

        {/* Hata + Generate butonu */}
        {selectedPreset && (
          <div className="flex items-center gap-3">
            {errorMsg && (
              <p className="flex-1 text-xs text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
                ⚠️ {errorMsg}
              </p>
            )}
            <button
              onClick={handleGenerate}
              className="ml-auto shrink-0 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:scale-95 text-white text-sm font-semibold transition-all shadow-lg shadow-blue-900/30"
            >
              {t.generate}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

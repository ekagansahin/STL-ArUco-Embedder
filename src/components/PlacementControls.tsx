/**
 * Placement control panel — all sliders.
 * Orientation (X/Y/Z rotation) is hidden by default; opened via the "Advanced Settings" toggle.
 */

import { useState } from 'react'

interface PlacementControlsProps {
  rotation: [number, number, number]
  markerX: number
  markerY: number
  markerSize: number
  etchDepth: number
  bounds: { minX: number; maxX: number; minY: number; maxY: number } | null
  lang: 'TR' | 'EN'
  onChange: (key: string, value: number) => void
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  /** Customise the value readout (e.g. square marker: "10 × 10 mm²"). */
  format?: (v: number) => string
  onChange: (v: number) => void
}

function Slider({ label, value, min, max, step, unit = '', format, onChange }: SliderProps) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-xs text-neutral-400">{label}</span>
        <span className="text-xs font-mono text-neutral-200">
          {format ? format(value) : `${value.toFixed(step < 1 ? 1 : 0)}${unit}`}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-500 cursor-pointer"
      />
    </div>
  )
}

export default function PlacementControls({
  rotation,
  markerX,
  markerY,
  markerSize,
  etchDepth,
  bounds,
  lang,
  onChange,
}: PlacementControlsProps) {
  const [showAdvanced, setShowAdvanced] = useState(false)

  const t = lang === 'TR'
    ? {
        orientation: 'Oryantasyon',
        rotX: 'X Dönüş', rotY: 'Y Dönüş', rotZ: 'Z Dönüş',
        position: 'Konum',
        posX: 'X Ekseni', posY: 'Y Ekseni',
        geometry: 'ArUco Geometrisi',
        size: 'Boyut', sizeHint: 'kenar, min 7.2 mm', depth: 'Oyma Derinliği',
        advanced: 'Gelişmiş Ayarlar',
        warnCell: (c: string) =>
          `Hücre boyutu ${c} mm — 2 mm altı hem baskıda hem kamerada güvenilmez. Marker ≥ 12 mm önerilir.`,
        warnQuiet: (q: string) =>
          `Marker parça kenarına çok yakın (sessiz bölge < 1 hücre = ${q} mm). Tespit için etrafında en az 1 hücre düz alan bırakın.`,
      }
    : {
        orientation: 'Orientation',
        rotX: 'X Rotation', rotY: 'Y Rotation', rotZ: 'Z Rotation',
        position: 'Position',
        posX: 'X Axis', posY: 'Y Axis',
        geometry: 'ArUco Geometry',
        size: 'Size', sizeHint: 'side, min 7.2 mm', depth: 'Etch Depth',
        advanced: 'Advanced Settings',
        warnCell: (c: string) =>
          `Cell size ${c} mm — below 2 mm is unreliable for both printing and camera detection. Marker ≥ 12 mm recommended.`,
        warnQuiet: (q: string) =>
          `Marker too close to part edge (quiet zone < 1 cell = ${q} mm). Leave at least 1 cell of flat area around it.`,
      }

  const xRange = bounds ? { min: bounds.minX, max: bounds.maxX } : { min: -100, max: 100 }
  const yRange = bounds ? { min: bounds.minY, max: bounds.maxY } : { min: -100, max: 100 }

  // ── Readability warnings ───────────────────────────────────────────────
  // Cell size: 6×6 grid (4×4 bits + border). Cells under 2 mm are unreliable both
  // when printing (bridging/stringing) and on camera (too few pixels).
  const cellSize = markerSize / 6
  const warnings: string[] = []
  if (cellSize < 2) warnings.push(t.warnCell(cellSize.toFixed(2)))
  // Quiet zone: ArUco detection needs a flat, light area around the marker's
  // black border. Approximate check against the bounding box (not the silhouette).
  if (bounds) {
    const half = markerSize / 2
    const quiet = Math.min(
      markerX - half - bounds.minX,
      bounds.maxX - (markerX + half),
      markerY - half - bounds.minY,
      bounds.maxY - (markerY + half),
    )
    if (quiet < cellSize) warnings.push(t.warnQuiet(cellSize.toFixed(2)))
  }

  return (
    <div className="space-y-5">
      {/* Advanced Settings — orientation toggle */}
      <div>
        <button
          onClick={() => setShowAdvanced(v => !v)}
          className="flex items-center justify-between w-full group"
        >
          <span className="text-xs text-neutral-500 uppercase tracking-wider group-hover:text-neutral-300 transition-colors">
            {t.advanced}
          </span>
          <span className="text-neutral-600 group-hover:text-neutral-400 transition-colors text-xs">
            {showAdvanced ? '▲' : '▼'}
          </span>
        </button>
        {showAdvanced && (
          <div className="mt-3 space-y-3">
            <div className="text-xs text-neutral-600 mb-2">{t.orientation}</div>
            <Slider label={t.rotX} value={rotation[0]} min={0} max={360} step={1} unit="°"
              onChange={(v) => onChange('rotX', v)} />
            <Slider label={t.rotY} value={rotation[1]} min={0} max={360} step={1} unit="°"
              onChange={(v) => onChange('rotY', v)} />
            <Slider label={t.rotZ} value={rotation[2]} min={0} max={360} step={1} unit="°"
              onChange={(v) => onChange('rotZ', v)} />
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800" />

      {/* Position */}
      <div>
        <div className="text-xs text-neutral-500 uppercase tracking-wider mb-3">{t.position}</div>
        <div className="space-y-3">
          <Slider label={t.posX} value={markerX} min={xRange.min} max={xRange.max} step={0.5} unit=" mm"
            onChange={(v) => onChange('markerX', v)} />
          <Slider label={t.posY} value={markerY} min={yRange.min} max={yRange.max} step={0.5} unit=" mm"
            onChange={(v) => onChange('markerY', v)} />
        </div>
      </div>

      <div className="border-t border-neutral-800" />

      {/* Geometry */}
      <div>
        <div className="text-xs text-neutral-500 uppercase tracking-wider mb-3">{t.geometry}</div>
        <div className="space-y-3">
          <Slider label={`${t.size} (${t.sizeHint})`} value={markerSize} min={7.2} max={50} step={0.5}
            format={(v) => `${v.toFixed(1)} × ${v.toFixed(1)} mm²`}
            onChange={(v) => onChange('markerSize', v)} />
          <Slider label={t.depth} value={etchDepth} min={0.2} max={2.0} step={0.1} unit=" mm"
            onChange={(v) => onChange('etchDepth', v)} />
        </div>
      </div>

      {/* Readability warnings */}
      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((w, i) => (
            <div key={i}
              className="text-xs text-amber-400 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2">
              ⚠ {w}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

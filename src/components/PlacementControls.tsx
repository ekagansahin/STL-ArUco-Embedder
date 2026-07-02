/**
 * Yerleşim kontrol paneli — tüm slider'lar.
 * Oryantasyon (X/Y/Z dönüş) varsayılan gizli; "Gelişmiş Ayarlar" toggle ile açılır.
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
  /** Değer okumasını özelleştir (ör. kare marker: "10 × 10 mm²"). */
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
        size: 'Boyut', depth: 'Oyma Derinliği',
        advanced: 'Gelişmiş Ayarlar',
      }
    : {
        orientation: 'Orientation',
        rotX: 'X Rotation', rotY: 'Y Rotation', rotZ: 'Z Rotation',
        position: 'Position',
        posX: 'X Axis', posY: 'Y Axis',
        geometry: 'ArUco Geometry',
        size: 'Size', depth: 'Etch Depth',
        advanced: 'Advanced Settings',
      }

  const xRange = bounds ? { min: bounds.minX, max: bounds.maxX } : { min: -100, max: 100 }
  const yRange = bounds ? { min: bounds.minY, max: bounds.maxY } : { min: -100, max: 100 }

  return (
    <div className="space-y-5">
      {/* Gelişmiş Ayarlar — Oryantasyon toggle */}
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

      {/* Konum */}
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

      {/* Geometri */}
      <div>
        <div className="text-xs text-neutral-500 uppercase tracking-wider mb-3">{t.geometry}</div>
        <div className="space-y-3">
          <Slider label={`${t.size} (kenar, min 7.2mm)`} value={markerSize} min={7.2} max={50} step={0.5}
            format={(v) => `${v.toFixed(1)} × ${v.toFixed(1)} mm²`}
            onChange={(v) => onChange('markerSize', v)} />
          <Slider label={t.depth} value={etchDepth} min={0.2} max={2.0} step={0.1} unit=" mm"
            onChange={(v) => onChange('etchDepth', v)} />
        </div>
      </div>
    </div>
  )
}

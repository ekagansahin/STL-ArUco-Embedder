/**
 * Akıllı preset kartları.
 * STL yüklenince otomatik analiz sonuçlarını 2-3 kart olarak sunar.
 */

import type { Preset } from '../lib/mesh'

interface PresetCardsProps {
  presets: Preset[]
  selected: string | null
  onSelect: (preset: Preset) => void
  lang: 'TR' | 'EN'
}

const BADGE_STYLES = {
  recommended: 'bg-green-900/60 text-green-400 border border-green-800',
  alternative:  'bg-blue-900/60 text-blue-400 border border-blue-800',
  manual:       'bg-neutral-800 text-neutral-400 border border-neutral-700',
}

const BADGE_LABELS = {
  recommended: { TR: '✅ FFF Önerisi', EN: '✅ FFF Recommended' },
  alternative:  { TR: '🔲 Alternatif',  EN: '🔲 Alternative' },
  manual:       { TR: '✏️ Manuel',       EN: '✏️ Manual' },
}

export default function PresetCards({ presets, selected, onSelect, lang }: PresetCardsProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500 uppercase tracking-wider mb-3">
        {lang === 'TR' ? 'Önerilen Yerleşimler' : 'Suggested Placements'}
      </p>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${presets.length}, minmax(0, 1fr))` }}>
        {presets.map((preset) => {
          const isSelected = selected === preset.id
          const label = lang === 'TR' ? preset.label : preset.labelEN
          const desc = lang === 'TR' ? preset.description : preset.descriptionEN

          return (
            <button
              key={preset.id}
              onClick={() => onSelect(preset)}
              disabled={!preset.isValid}
              className={`
                relative rounded-xl border p-3 text-left transition-all duration-150
                ${isSelected
                  ? 'border-blue-500 bg-blue-950/40 shadow-lg shadow-blue-900/20'
                  : 'border-neutral-800 bg-neutral-900 hover:border-neutral-600 hover:bg-neutral-800'}
                ${!preset.isValid ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              {/* Rozet */}
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${BADGE_STYLES[preset.badge]}`}>
                {BADGE_LABELS[preset.badge][lang]}
              </span>

              {/* Başlık */}
              <div className="mt-2 font-semibold text-sm text-neutral-100">{label}</div>

              {/* Açıklama */}
              <div className="mt-1 text-xs text-neutral-500 leading-relaxed">{desc}</div>

              {/* Parametreler */}
              {preset.badge !== 'manual' && (
                <div className="mt-2 flex gap-2 flex-wrap">
                  <span className="text-[10px] bg-neutral-800 text-neutral-400 px-1.5 py-0.5 rounded">
                    {preset.markerSize}mm
                  </span>
                  <span className="text-[10px] bg-neutral-800 text-neutral-400 px-1.5 py-0.5 rounded">
                    {preset.etchDepth}mm derinlik
                  </span>
                </div>
              )}

              {!preset.isValid && (
                <div className="mt-1 text-[10px] text-red-400">
                  {preset.validationMessage ?? (lang === 'TR' ? 'Yüzey çok küçük' : 'Surface too small')}
                </div>
              )}

              {/* Seçim göstergesi */}
              {isSelected && (
                <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-blue-500" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

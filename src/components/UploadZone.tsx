/**
 * STL sürükle-bırak yükleme alanı.
 */

import { useCallback, useState } from 'react'

interface UploadZoneProps {
  onFile: (buffer: ArrayBuffer, name: string) => void
  lang: 'TR' | 'EN'
}

export default function UploadZone({ onFile, lang }: UploadZoneProps) {
  const [dragging, setDragging] = useState(false)

  const handleFile = useCallback(
    (file: File) => {
      if (!file.name.toLowerCase().endsWith('.stl')) {
        alert(lang === 'TR' ? 'Yalnızca .stl dosyaları desteklenir' : 'Only .stl files are supported')
        return
      }
      const reader = new FileReader()
      reader.onload = (e) => {
        if (e.target?.result instanceof ArrayBuffer) {
          onFile(e.target.result, file.name)
        }
      }
      reader.readAsArrayBuffer(file)
    },
    [onFile, lang]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile]
  )

  return (
    <label
      className={`
        flex flex-col items-center justify-center gap-3
        border-2 border-dashed rounded-xl p-8 cursor-pointer
        transition-colors duration-150 select-none
        ${dragging
          ? 'border-blue-500 bg-blue-950/30'
          : 'border-neutral-700 bg-neutral-900 hover:border-neutral-500 hover:bg-neutral-800'}
      `}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        type="file"
        accept=".stl"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
      />
      <div className="text-4xl">📦</div>
      <div className="text-center">
        <p className="text-sm text-neutral-200 font-medium">
          {lang === 'TR' ? 'STL dosyasını buraya sürükle' : 'Drop your STL file here'}
        </p>
        <p className="text-xs text-neutral-500 mt-1">
          {lang === 'TR' ? 'veya tıkla ve seç' : 'or click to browse'}
        </p>
      </div>
    </label>
  )
}

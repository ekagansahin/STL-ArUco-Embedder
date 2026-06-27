/**
 * Parça kütüphanesi — IndexedDB'deki tüm parçaları listeler.
 * Proje dışa/içe aktarma ve tüm hafızayı silme butonları içerir.
 */

import { useEffect, useRef, useState } from 'react'
import { getAllParts, deletePart, clearAllParts, type Part } from '../lib/db'
import { downloadBuffer } from '../lib/export'
import { exportProject, importProject } from '../lib/project-io'

interface LibraryPageProps {
  lang: 'TR' | 'EN'
}

export default function LibraryPage({ lang }: LibraryPageProps) {
  const [parts, setParts]         = useState<Part[]>([])
  const [loading, setLoading]     = useState(true)
  const [busy, setBusy]           = useState(false)
  const [toast, setToast]         = useState<{ msg: string; ok: boolean } | null>(null)
  const [projectName, setProjectName] = useState('aruco_project')
  const importInputRef            = useRef<HTMLInputElement>(null)

  const t = lang === 'TR'
    ? {
        title:          'Parça Kütüphanesi',
        empty:          'Henüz parça eklenmedi. Embedder\'dan bir parça oluştur.',
        mat:            'Malzeme',
        date:           'Tarih',
        delete:         'Sil',
        confirmDelete:  'Bu parçayı silmek istediğine emin misin?',
        dlOriginal:     '⬇ Orijinal STL',
        dlPrintReady:   '⬇ Baskıya Hazır STL',
        export:         '⬇ Projeyi İndir',
        import:         '⬆ Proje Yükle',
        clearAll:               '🗑 Tüm Hafızayı Sil',
        confirmClear:           'Kütüphanedeki tüm parçalar silinecek. Emin misin?',
        projectNamePlaceholder: 'Proje adı…',
        processing:     'İşleniyor…',
        exportEmpty:    'Dışa aktarılacak parça yok.',
        importSuccess:  (n: number, s: number) =>
          s > 0
            ? `${n} parça yüklendi, ${s} parça zaten vardı (atlandı).`
            : `${n} parça başarıyla yüklendi.`,
        importError:    'ZIP okunamadı — geçerli bir proje dosyası seç.',
        cleared:        'Tüm parçalar silindi.',
      }
    : {
        title:          'Part Library',
        empty:          'No parts yet. Create one from the Embedder.',
        mat:            'Material',
        date:           'Date',
        delete:         'Delete',
        confirmDelete:  'Are you sure you want to delete this part?',
        dlOriginal:     '⬇ Original STL',
        dlPrintReady:   '⬇ Print-Ready STL',
        export:         '⬇ Export Project',
        import:         '⬆ Import Project',
        clearAll:               '🗑 Clear All',
        confirmClear:           'All parts in the library will be deleted. Are you sure?',
        projectNamePlaceholder: 'Project name…',
        processing:     'Processing…',
        exportEmpty:    'Nothing to export.',
        importSuccess:  (n: number, s: number) =>
          s > 0
            ? `${n} part(s) imported, ${s} already existed (skipped).`
            : `${n} part(s) imported successfully.`,
        importError:    'Could not read ZIP — select a valid project file.',
        cleared:        'All parts deleted.',
      }

  // ─── Yardımcı ──────────────────────────────────────────────────────────────

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 4000)
  }

  const load = async () => {
    setLoading(true)
    setParts(await getAllParts())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // ─── Parça işlemleri ───────────────────────────────────────────────────────

  const handleDelete = async (part: Part) => {
    if (!window.confirm(t.confirmDelete)) return
    await deletePart(part.id!)
    load()
  }

  // ─── Proje işlemleri ───────────────────────────────────────────────────────

  const handleExport = async () => {
    if (parts.length === 0) { showToast(t.exportEmpty, false); return }
    setBusy(true)
    try {
      await exportProject(projectName.trim() || 'aruco_project')
    } catch (e: any) {
      showToast(e?.message ?? 'Hata', false)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // ZIP dosya adını proje adı olarak göster (.zip uzantısını kaldır)
    const nameFromFile = file.name.replace(/\.zip$/i, '')
    e.target.value = ''   // aynı dosyayı tekrar seçebilmek için sıfırla
    setBusy(true)
    try {
      const { imported, skipped } = await importProject(file)
      setProjectName(nameFromFile)
      showToast(t.importSuccess(imported, skipped))
      load()
    } catch {
      showToast(t.importError, false)
    } finally {
      setBusy(false)
    }
  }

  const handleClearAll = async () => {
    if (!window.confirm(t.confirmClear)) return
    await clearAllParts()
    showToast(t.cleared)
    load()
  }

  // ─── UI ────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">

      {/* Başlık + proje adı + butonlar */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-semibold text-neutral-100 shrink-0">{t.title}</h2>
        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder={t.projectNamePlaceholder}
          className="flex-1 min-w-32 bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-blue-500"
        />

        <button
          onClick={handleExport}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-neutral-100 border border-neutral-700 transition-colors disabled:opacity-40"
        >
          {t.export}
        </button>

        {/* Gizli file input */}
        <input
          ref={importInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={handleImportFile}
        />
        <button
          onClick={() => importInputRef.current?.click()}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-neutral-100 border border-neutral-700 transition-colors disabled:opacity-40"
        >
          {t.import}
        </button>

        <button
          onClick={handleClearAll}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-red-950/60 hover:bg-red-900/60 text-red-400 hover:text-red-300 border border-red-900 transition-colors disabled:opacity-40"
        >
          {t.clearAll}
        </button>
      </div>

      {/* Toast bildirimi */}
      {toast && (
        <div className={`text-sm px-4 py-2.5 rounded-xl border ${
          toast.ok
            ? 'bg-green-950/40 border-green-900 text-green-400'
            : 'bg-red-950/40 border-red-900 text-red-400'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Busy göstergesi */}
      {busy && (
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          {t.processing}
        </div>
      )}

      {/* Parça listesi */}
      {loading && (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!loading && parts.length === 0 && (
        <div className="text-center py-16 text-neutral-600">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">{t.empty}</p>
        </div>
      )}

      {!loading && parts.length > 0 && (
        <div className="space-y-3">
          {parts.map((part) => (
            <div
              key={part.id}
              className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex items-start gap-4"
            >
              {/* ID rozeti */}
              <div className="shrink-0 w-12 h-12 rounded-xl bg-blue-950 border border-blue-800 flex items-center justify-center">
                <span className="text-blue-400 font-mono font-bold text-sm">{part.markerId}</span>
              </div>

              {/* Bilgiler */}
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-neutral-100 text-sm truncate">{part.name}</div>
                <div className="flex gap-3 mt-1 flex-wrap">
                  <span className="text-xs text-neutral-500">{t.mat}: <span className="text-neutral-300">{part.material}</span></span>
                  <span className="text-xs text-neutral-500">{t.date}: <span className="text-neutral-300">{new Date(part.createdAt).toLocaleDateString()}</span></span>
                </div>
                {part.notes && (
                  <p className="text-xs text-neutral-600 mt-1 truncate">{part.notes}</p>
                )}
                <p className="text-xs text-neutral-700 mt-1 truncate font-mono">{part.filename}</p>
              </div>

              {/* İndirme + Sil */}
              <div className="shrink-0 flex flex-col gap-1 items-end">
                {part.originalStl && (
                  <button
                    onClick={() => downloadBuffer(part.originalStl!, `ID_${part.markerId}_original.stl`)}
                    className="text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-950/40 px-2 py-1 rounded-lg transition-colors whitespace-nowrap"
                  >
                    {t.dlOriginal}
                  </button>
                )}
                {part.printReadyStl && (
                  <button
                    onClick={() => downloadBuffer(part.printReadyStl!, part.filename)}
                    className="text-xs text-green-400 hover:text-green-300 hover:bg-green-950/40 px-2 py-1 rounded-lg transition-colors whitespace-nowrap"
                  >
                    {t.dlPrintReady}
                  </button>
                )}
                <button
                  onClick={() => handleDelete(part)}
                  className="text-xs text-red-500 hover:text-red-400 hover:bg-red-950/40 px-2 py-1 rounded-lg transition-colors"
                >
                  {t.delete}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

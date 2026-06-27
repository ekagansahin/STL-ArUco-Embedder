/**
 * Proje dışa/içe aktarma.
 *
 * ZIP yapısı:
 *   ID_0_PartName/
 *     original.stl       (varsa)
 *     print_ready.stl    (varsa)
 *   ID_3_Other/
 *     ...
 *   database.json        ← tüm metadata, folder alanı ile birlikte
 */

import JSZip from 'jszip'
import { getAllParts, savePart, db, type Part } from './db'

// ─── Yardımcı ────────────────────────────────────────────────────────────────

/** Klasör adı: ID_0_PartName (URL-safe karakterler) */
function folderName(part: Part): string {
  const safeName = part.name.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return `ID_${part.markerId}_${safeName || 'Part'}`
}

// ─── Dışa Aktar ──────────────────────────────────────────────────────────────

export async function exportProject(projectName = 'aruco_project'): Promise<void> {
  const parts = await getAllParts()
  if (parts.length === 0) throw new Error('Kütüphane boş — dışa aktarılacak parça yok.')

  const zip = new JSZip()

  // Metadata listesi (ArrayBuffer'lar hariç)
  const dbEntries: object[] = []

  for (const part of parts) {
    const folder = folderName(part)

    if (part.originalStl) {
      zip.file(`${folder}/original.stl`, part.originalStl)
    }
    if (part.printReadyStl) {
      zip.file(`${folder}/print_ready.stl`, part.printReadyStl)
    }

    dbEntries.push({
      markerId:  part.markerId,
      name:      part.name,
      material:  part.material,
      notes:     part.notes,
      createdAt: part.createdAt,
      filename:  part.filename,
      folder,
    })
  }

  zip.file('database.json', JSON.stringify(dbEntries, null, 2))

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${projectName}.zip`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── İçe Aktar ───────────────────────────────────────────────────────────────

export interface ImportResult {
  imported: number
  skipped:  number   // zaten var olan markerId'ler
}

export async function importProject(file: File): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer())

  // database.json oku
  const dbFile = zip.file('database.json')
  if (!dbFile) throw new Error('Geçersiz ZIP: database.json bulunamadı.')

  const entries = JSON.parse(await dbFile.async('text')) as Array<{
    markerId:  number
    name:      string
    material:  string
    notes:     string
    createdAt: string
    filename:  string
    folder:    string
  }>

  // Mevcut markerId'leri al (çakışma kontrolü)
  const existing = await db.parts.toArray()
  const existingIds = new Set(existing.map((p) => p.markerId))

  let imported = 0
  let skipped  = 0

  for (const entry of entries) {
    if (existingIds.has(entry.markerId)) {
      skipped++
      continue
    }

    // STL dosyalarını oku (yoksa undefined)
    const originalFile    = zip.file(`${entry.folder}/original.stl`)
    const printReadyFile  = zip.file(`${entry.folder}/print_ready.stl`)

    const originalStl    = originalFile   ? await originalFile.async('arraybuffer')   : undefined
    const printReadyStl  = printReadyFile ? await printReadyFile.async('arraybuffer') : undefined

    await savePart({
      markerId:  entry.markerId,
      name:      entry.name,
      material:  entry.material,
      notes:     entry.notes,
      createdAt: entry.createdAt,
      filename:  entry.filename,
      originalStl,
      printReadyStl,
    })

    imported++
  }

  return { imported, skipped }
}

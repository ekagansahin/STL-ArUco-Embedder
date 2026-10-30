/**
 * Project export / import.
 *
 * ZIP layout:
 *   ID_0_PartName/
 *     original.stl       (if present)
 *     print_ready.stl    (if present)
 *   ID_3_Other/
 *     ...
 *   database.json        ← all metadata, including the folder field
 */

import JSZip from 'jszip'
import { getAllParts, savePart, db, type Part } from './db'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Folder name: ID_0_PartName (URL-safe characters) */
function folderName(part: Part): string {
  const safeName = part.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return `ID_${part.markerId}_${safeName || 'Part'}`
}

// ─── Export ──────────────────────────────────────────────────────────────────

export async function exportProject(projectName = 'aruco_project'): Promise<void> {
  const parts = await getAllParts()
  if (parts.length === 0) throw new Error('The library is empty — there are no parts to export.')

  const zip = new JSZip()

  // Metadata list (without the ArrayBuffers)
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

// ─── Import ──────────────────────────────────────────────────────────────────

export interface ImportResult {
  imported: number
  skipped:  number   // markerIds that already exist
}

export async function importProject(file: File): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer())

  // Read database.json
  const dbFile = zip.file('database.json')
  if (!dbFile) throw new Error('Invalid ZIP: database.json not found.')

  const entries = JSON.parse(await dbFile.async('text')) as Array<{
    markerId:  number
    name:      string
    material:  string
    notes:     string
    createdAt: string
    filename:  string
    folder:    string
  }>

  // Get the existing markerIds (conflict check)
  const existing = await db.parts.toArray()
  const existingIds = new Set(existing.map((p) => p.markerId))

  let imported = 0
  let skipped  = 0

  for (const entry of entries) {
    if (existingIds.has(entry.markerId)) {
      skipped++
      continue
    }

    // Read the STL files (undefined if missing)
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

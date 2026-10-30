/**
 * Parts database — Dexie.js (IndexedDB).
 * No login required; data stays on the device.
 */

import Dexie, { type Table } from 'dexie'

export interface Part {
  id?: number
  markerId: number
  name: string
  material: string
  notes: string
  createdAt: string
  /** File name of the downloaded STL */
  filename: string
  /** Original STL binary data (without the marker) */
  originalStl?: ArrayBuffer
  /** Print-ready STL binary data (with the marker embedded) */
  printReadyStl?: ArrayBuffer
}

class ArUcoDatabase extends Dexie {
  parts!: Table<Part>

  constructor() {
    super('ArUcoDB')
    // v1 → existing records (no files)
    this.version(1).stores({
      parts: '++id, markerId, name, createdAt',
    })
    // v2 → added originalStl and printReadyStl fields (ArrayBuffer, not indexed)
    // The schema string stays the same; the new Dexie version is only needed for the migration
    this.version(2).stores({
      parts: '++id, markerId, name, createdAt',
    })
  }
}

export const db = new ArUcoDatabase()

export async function getNextMarkerId(): Promise<number> {
  const all = await db.parts.toArray()
  const usedIds = new Set(all.map((p) => p.markerId))
  for (let i = 0; i < 50; i++) {
    if (!usedIds.has(i)) return i
  }
  throw new Error('All marker IDs (0–49) are already in use')
}

export async function savePart(part: Omit<Part, 'id'>): Promise<number> {
  return db.parts.add(part)
}

export async function getAllParts(): Promise<Part[]> {
  return db.parts.orderBy('createdAt').reverse().toArray()
}

export async function getPartByMarkerId(markerId: number): Promise<Part | undefined> {
  return db.parts.where('markerId').equals(markerId).first()
}

export async function deletePart(id: number): Promise<void> {
  return db.parts.delete(id)
}

export async function clearAllParts(): Promise<void> {
  return db.parts.clear()
}

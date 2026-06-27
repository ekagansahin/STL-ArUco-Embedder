/**
 * Parça veritabanı — Dexie.js (IndexedDB).
 * Login gerektirmez; veri cihazda kalır.
 */

import Dexie, { type Table } from 'dexie'

export interface Part {
  id?: number
  markerId: number
  name: string
  material: string
  notes: string
  createdAt: string
  /** İndirilen STL dosyasının adı */
  filename: string
  /** Orijinal (marker gömülmemiş) STL binary verisi */
  originalStl?: ArrayBuffer
  /** Baskıya hazır (marker gömülmüş) STL binary verisi */
  printReadyStl?: ArrayBuffer
}

class ArUcoDatabase extends Dexie {
  parts!: Table<Part>

  constructor() {
    super('ArUcoDB')
    // v1 → mevcut kayıtlar (dosya yok)
    this.version(1).stores({
      parts: '++id, markerId, name, createdAt',
    })
    // v2 → originalStl ve printReadyStl alanları eklendi (ArrayBuffer, index yok)
    // Şema string aynı kalır; Dexie yeni sürüm sadece migration için gerekli
    this.version(2).stores({
      parts: '++id, markerId, name, createdAt',
    })
  }
}

export const db = new ArUcoDatabase()

export async function getNextMarkerId(): Promise<number> {
  const all = await db.parts.toArray()
  const usedIds = new Set(all.map((p) => p.markerId))
  for (let i = 0; i < 1000; i++) {
    if (!usedIds.has(i)) return i
  }
  throw new Error('Tüm ID\'ler (0-999) kullanılmış')
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

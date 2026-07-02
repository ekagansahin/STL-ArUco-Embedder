/**
 * ArUco marker mesh üreticisi.
 * Önceden üretilmiş aruco_dict_4x4_50.json'dan bit pattern okur,
 * siyah hücreleri manifold-3d box'larına dönüştürür.
 * NOT: 4x4_50 sözlüğü — kodlar arası mesafe yüksek, yanlış okumaya dayanıklı.
 */

import { getManifold } from './manifold'
import arucoDict from '../assets/aruco_dict_4x4_50.json'

/** marker ID için 6×6 bit grid döndürür (1=siyah, 0=beyaz) */
export function getMarkerBits(id: number): number[][] {
  if (id < 0 || id >= arucoDict.length) throw new Error(`ArUco ID ${id} geçersiz (0-49)`)
  return arucoDict[id] as number[][]
}

/**
 * Manifold boolean çıkarma için ArUco geometrisi üretir.
 * Sonuç: z=0'da ortalanmış, siyah hücrelerin birleşimi olan manifold nesnesi.
 *
 * Kullanım:
 *   const aruco = await generateArucoManifold(markerId, sizeInMm, depthInMm)
 *   aruco.translate([cx, cy, z_min])  → parçadan çıkarılacak nesne
 */
export async function generateArucoManifold(
  markerId: number,
  size: number,   // mm cinsinden toplam boyut (örn. 15)
  depth: number,  // mm cinsinden oyma derinliği (örn. 0.6)
) {
  const { Manifold } = await getManifold()
  const bits = getMarkerBits(markerId)

  const cellSize = size / 6
  const offset = size / 2

  // Boş başlat
  let result: any = null

  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      if (bits[row][col] !== 1) continue

      const cx = col * cellSize + cellSize / 2 - offset
      const cy = -(row * cellSize + cellSize / 2 - offset) // Y eksenini çevir

      // Kutuyu z merkezli oluştur; oymada tam kesilmesi için depth*2 yükseklik
      // 0.999 faktörü: bitişik hücrelerde tam yüzey çakışmasını önler
      const box = Manifold.cube(
        [cellSize * 0.999, cellSize * 0.999, depth * 2],
        true // merkezli
      )
      const placed = box.translate([cx, cy, 0])
      result = result ? result.add(placed) : placed
    }
  }

  if (!result) throw new Error('ArUco marker hiç siyah hücre içermiyor')
  return result
}

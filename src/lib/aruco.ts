/**
 * ArUco marker mesh üreticisi.
 * Önceden üretilmiş aruco_dict_4x4_50.json'dan bit pattern okur,
 * siyah hücreleri manifold-3d frustum'larına (konik oyuk) dönüştürür.
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
 * Sonuç: z=0'da yüzey açıklığı olan, siyah hücrelerin birleşimi.
 * Her hücre = alt yarı prizma (z ∈ [-depth, 0], temiz kesim payı)
 *            + üst yarı KESİK PİRAMİT (z ∈ [0, depth], içe daralan).
 *
 * NEDEN konik (frustum) oyuk, dik duvarlı kutu değil:
 *  1. Baskı: alt yüzeye gömülü markerda dik duvarlı cebin tavanı tam hücre
 *     genişliğinde köprülenir → sarkma/iplik oyuğu doldurur (okuma bozulur),
 *     derin oymada yazıcı fail verir. Eğimli duvar kendi kendini taşır,
 *     kalan köprü açıklığı ~hücrenin %40'ına düşer.
 *  2. Okuma: eğimli duvarlar geniş açıdan gelen ışığı da gölgeler →
 *     tek renk gravürde kontrast alanı büyür.
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

  // 1.001 faktörü: komşu siyah hücreler kesin ÇAKIŞSIN diye hafif büyütme.
  // (Eski 0.999 küçültme komşu hücreler arasında mikron-mertebesi duvar
  // bırakıyordu; slicer bunu iplik/artefakta çeviriyordu.)
  const w = cellSize * 1.001
  const half = w / 2
  const square: Array<[number, number]> = [
    [-half, -half], [half, -half], [half, half], [-half, half],
  ]

  // Duvar pahı: her kenardan içe daralma. depth ile sınırlı (≈45°'e kadar),
  // ama tavan köprüsü hücrenin %40'ından dar olmasın diye %30 ile kırpılır.
  const inset = Math.min(depth, cellSize * 0.3)
  const topScale = Math.max(0.05, (w - 2 * inset) / w)

  let result: any = null

  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      if (bits[row][col] !== 1) continue

      const cx = col * cellSize + cellSize / 2 - offset
      const cy = -(row * cellSize + cellSize / 2 - offset) // Y eksenini çevir

      // Üst yarı: yüzeyde (z=0) tam genişlik → z=depth'te daralmış (frustum)
      const frustum = Manifold.extrude([square], depth, 0, 0, [topScale, topScale])
      // Alt yarı: z ∈ [-depth, 0] tam genişlik prizma — yüzey altı temiz kesim payı
      const prism = Manifold.extrude([square], depth).translate([0, 0, -depth])

      const cell = frustum.add(prism).translate([cx, cy, 0])
      result = result ? result.add(cell) : cell
    }
  }

  if (!result) throw new Error('ArUco marker hiç siyah hücre içermiyor')
  return result
}

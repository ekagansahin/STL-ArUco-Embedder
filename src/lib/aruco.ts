/**
 * ArUco marker mesh üreticisi.
 * Önceden üretilmiş aruco_dict_4x4_50.json'dan bit pattern okur,
 * siyah hücreleri BİRLEŞİK 2D bölge + kademeli içe-offset pahlı
 * oyuk hacmine dönüştürür.
 * NOT: 4x4_50 sözlüğü — kodlar arası mesafe yüksek, yanlış okumaya dayanıklı.
 */

import { getManifold } from './manifold'
import arucoDict from '../assets/aruco_dict_4x4_50.json'

/** marker ID için 6×6 bit grid döndürür (1=siyah, 0=beyaz) */
export function getMarkerBits(id: number): number[][] {
  if (id < 0 || id >= arucoDict.length) throw new Error(`ArUco ID ${id} geçersiz (0-49)`)
  return arucoDict[id] as number[][]
}

/** Pah kademesi sayısı — 0.8mm derinlikte kademe ≈ 0.2mm ≈ tipik katman yüksekliği */
const CHAMFER_STEPS = 4

/**
 * Manifold boolean çıkarma için ArUco geometrisi üretir.
 * Sonuç: z=0'da yüzey açıklığı olan oyuk hacmi.
 *
 * Yapı:
 *  - Siyah hücre kareleri (1.001 büyütme ile örtüşen) TEK 2D bölgede
 *    birleştirilir (CrossSection, Positive fill).
 *  - z ∈ [-depth, 0]: birleşik bölge tam genişlik (yüzey altı temiz kesim payı).
 *  - z ∈ [0, depth]: CHAMFER_STEPS kademede bölge dış hattı içe offset'lenir
 *    → oyuk duvarları merdiven şeklinde daralır (baskıda katman yüksekliği
 *    zaten kademeler; sonuç pürüzsüz pah ile aynı).
 *
 * NEDEN birleşik bölge + offset, hücre-bazlı frustum DEĞİL:
 *  Hücre bazında pahlama, kaynaşmış komşu siyah hücrelerin ARASINDA tabanı
 *  sıfır genişlikte başlayıp yukarı doğru kalınlaşan kama sırtları üretir
 *  (ör. 0.8mm derinlikte tepede ~0.75mm, tabanda 0mm). Slicer bu bıçak
 *  sırtlarını tutunamayan kıvrık ipliklere çevirir → oyuklar çöple dolar,
 *  hücre sınırları kaybolur (saha gözlemi, 2026-07-03 baskısı). Birleşik
 *  bölgenin yalnız DIŞ hattını offset'lemek iç kısmı tamamen açık bırakır;
 *  hücreler arasında hiçbir ara geometri oluşmaz.
 *
 * NEDEN pah (offset) hâlâ var:
 *  1. Alt yüzey gömmede oyuk tavanı köprülenir; içe daralan duvar kalan
 *     köprü açıklığını ~%40'a indirir → sarkma/iplik azalır.
 *  2. Eğimli/kademeli duvar geniş açıdan ışığı da gölgeler → tek renk
 *     gravürde kontrast alanı büyür.
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
  const { Manifold, CrossSection } = await getManifold()
  const bits = getMarkerBits(markerId)

  const cellSize = size / 6
  const offset = size / 2

  // 1.001 faktörü: komşu siyah hücreler kesin örtüşsün → union'da tek bölge.
  // (0.999 küçültme komşular arasında mikron duvar bırakıyordu.)
  const half = (cellSize * 1.001) / 2

  const polygons: Array<Array<[number, number]>> = []
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      if (bits[row][col] !== 1) continue
      const cx = col * cellSize + cellSize / 2 - offset
      const cy = -(row * cellSize + cellSize / 2 - offset) // Y eksenini çevir
      polygons.push([
        [cx - half, cy - half], [cx + half, cy - half],
        [cx + half, cy + half], [cx - half, cy + half],
      ])
    }
  }
  if (polygons.length === 0) throw new Error('ArUco marker hiç siyah hücre içermiyor')

  // Örtüşen kareler Positive fill ile tek bölgede birleşir
  const region = new CrossSection(polygons, 'Positive')

  // Duvar pahı: dış hattan içe toplam daralma. Tek hücrede tavan köprüsü
  // hücrenin %40'ından dar olmasın diye %30 ile sınırlı.
  const inset = Math.min(depth, cellSize * 0.3)

  // Alt yarı: z ∈ [-depth, 0] tam genişlik — yüzey altı temiz kesim payı
  let result: any = Manifold.extrude(region.toPolygons(), depth).translate([0, 0, -depth])

  // Üst yarı: kademeli içe offset (yüzeyde tam, z=depth'te -inset)
  const stepH = depth / CHAMFER_STEPS
  for (let k = 0; k < CHAMFER_STEPS; k++) {
    const shrunk = k === 0 ? region : region.offset(-(inset * k) / CHAMFER_STEPS, 'Miter')
    if (shrunk.area() < 1e-6) break // bölge tamamen kapandı — kalan kademeler boş
    const slab = Manifold.extrude(shrunk.toPolygons(), stepH).translate([0, 0, k * stepH])
    result = result.add(slab)
  }

  return result
}

/**
 * Mesh analizi, akıllı preset üretimi ve Three.js ↔ Manifold dönüşümleri.
 */

import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { getManifold } from './manifold'
import { generateArucoManifold } from './aruco'

// ─── Tipler ────────────────────────────────────────────────────────────────

export interface Preset {
  id: string
  label: string
  labelEN: string
  description: string
  descriptionEN: string
  badge: 'recommended' | 'alternative' | 'manual'
  /** Euler açıları (derece) — mesh'e uygulanacak rotasyon */
  rotation: [number, number, number]
  /** Rotasyon sonrası model koordinatlarında marker merkezi */
  position: [number, number]
  markerSize: number   // mm
  etchDepth: number    // mm
  isValid: boolean
  validationMessage?: string
}

export interface PlacementParams {
  markerId: number
  rotation: [number, number, number]
  position: [number, number]
  markerSize: number
  etchDepth: number
}

// ─── STL Yükleme ───────────────────────────────────────────────────────────

const loader = new STLLoader()

export function loadSTLFromBuffer(buffer: ArrayBuffer): THREE.BufferGeometry {
  const geo = loader.parse(buffer)
  geo.computeVertexNormals()
  return geo
}

// ─── Three.js ↔ Manifold Dönüşümleri ──────────────────────────────────────

export function geometryToManifold(mod: any, geo: THREE.BufferGeometry): any {
  // ── Adım 1: toNonIndexed ──────────────────────────────────────────────
  const nonIdx = geo.clone().toNonIndexed()

  // ── Adım 2: mergeVertices ─────────────────────────────────────────────
  // CRITICAL: mergeVertices tüm attribute'ları hash'liyor.
  // Normal attribute varsa, aynı pozisyondaki ama farklı face'e ait vertex'ler
  // farklı normal'a sahip olduğundan merge edilmiyor → non-manifold mesh.
  // Çözüm: merge öncesi normal'ı sil, sonra yeniden hesapla.
  if (nonIdx.hasAttribute('normal')) nonIdx.deleteAttribute('normal')

  const merged = mergeVertices(nonIdx, 1e-4)
  merged.computeVertexNormals()

  const posAttr = merged.attributes.position
  const vertCount = posAttr.count

  const vertProps = new Float32Array(vertCount * 3)
  for (let i = 0; i < vertCount; i++) {
    vertProps[i * 3]     = posAttr.getX(i)
    vertProps[i * 3 + 1] = posAttr.getY(i)
    vertProps[i * 3 + 2] = posAttr.getZ(i)
  }

  const idxAttr = merged.index
  if (!idxAttr) throw new Error('Mesh indexlenemedi — mergeVertices başarısız')
  const triVerts = new Uint32Array(idxAttr.array)

  if (triVerts.length % 3 !== 0) throw new Error(`Index sayısı 3'ün katı olmalı: ${triVerts.length}`)

  const mesh = new mod.Mesh({ numProp: 3, vertProperties: vertProps, triVerts, tolerance: 1e-6 })
  return new mod.Manifold(mesh)
}

export function manifoldToGeometry(manifoldObj: any): THREE.BufferGeometry {
  const m = manifoldObj.getMesh()
  const numProp: number = m.numProp
  const rawProps: Float32Array = m.vertProperties
  const vertCount = rawProps.length / numProp

  const positions = new Float32Array(vertCount * 3)
  for (let i = 0; i < vertCount; i++) {
    positions[i * 3]     = rawProps[i * numProp]
    positions[i * 3 + 1] = rawProps[i * numProp + 1]
    positions[i * 3 + 2] = rawProps[i * numProp + 2]
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(new THREE.Uint32BufferAttribute(m.triVerts, 1))
  geo.computeVertexNormals()
  return geo
}

// ─── Akıllı Preset Analizi ─────────────────────────────────────────────────

interface FaceGroup {
  normal: THREE.Vector3
  area: number
}

/** Geometrideki yüz normallerini alana göre gruplar */
function analyzeFaceNormals(geo: THREE.BufferGeometry): FaceGroup[] {
  const posAttr = geo.attributes.position
  const normAttr = geo.attributes.normal

  const groups = new Map<string, FaceGroup>()

  for (let i = 0; i < posAttr.count; i += 3) {
    // Yüz normali: 3 vertex normalinin ortalaması
    const nx = (normAttr.getX(i) + normAttr.getX(i + 1) + normAttr.getX(i + 2)) / 3
    const ny = (normAttr.getY(i) + normAttr.getY(i + 1) + normAttr.getY(i + 2)) / 3
    const nz = (normAttr.getZ(i) + normAttr.getZ(i + 1) + normAttr.getZ(i + 2)) / 3
    const n = new THREE.Vector3(nx, ny, nz).normalize()

    // Yüz alanı (Heron)
    const a = new THREE.Vector3().fromBufferAttribute(posAttr, i)
    const b = new THREE.Vector3().fromBufferAttribute(posAttr, i + 1)
    const c = new THREE.Vector3().fromBufferAttribute(posAttr, i + 2)
    const area = new THREE.Triangle(a, b, c).getArea()

    // Normal yönünü 0.15 hassasiyetle grupla
    const key = `${n.x.toFixed(1)},${n.y.toFixed(1)},${n.z.toFixed(1)}`

    if (groups.has(key)) {
      groups.get(key)!.area += area
    } else {
      groups.set(key, { normal: n.clone(), area })
    }
  }

  return [...groups.values()].sort((a, b) => b.area - a.area)
}

/** dominant_normal'ı -Z'ye hizalayan rotasyon matrisini döndürür */
function rotationToAlignFaceDown(dominantNormal: THREE.Vector3): THREE.Matrix4 {
  const target = new THREE.Vector3(0, 0, -1)
  const src = dominantNormal.clone().normalize()

  // Zaten -Z'de mi?
  if (src.dot(target) > 0.9999) return new THREE.Matrix4()
  // Tam tersi (+Z)?
  if (src.dot(target) < -0.9999) {
    return new THREE.Matrix4().makeRotationX(Math.PI)
  }

  const axis = new THREE.Vector3().crossVectors(src, target).normalize()
  const angle = Math.acos(Math.max(-1, Math.min(1, src.dot(target))))
  return new THREE.Matrix4().makeRotationAxis(axis, angle)
}

/** Rotasyon uygulanmış geometrinin bounding box'ına göre preset parametrelerini hesaplar */
function computePresetParams(geo: THREE.BufferGeometry, rotMatrix: THREE.Matrix4, positionVariant: 'center' | 'corner') {
  const rotated = geo.clone()
  rotated.applyMatrix4(rotMatrix)
  rotated.computeBoundingBox()
  const bb = rotated.boundingBox!

  const width = bb.max.x - bb.min.x
  const height = bb.max.y - bb.min.y
  const shortSide = Math.min(width, height)

  // Boyut: kısa kenarın %25'i, 7.2–30mm arasında
  const markerSize = 10   // sabit 10x10 mm (kullanıcı tercihi)
  const etchDepth = 0.8   // oyma derinliği 0.8 mm

  const cx = (bb.min.x + bb.max.x) / 2
  const cy = (bb.min.y + bb.max.y) / 2

  let position: [number, number]
  if (positionVariant === 'center') {
    position = [cx, cy]
  } else {
    // Sol-alt köşe, padding ile
    const padX = width * 0.15
    const padY = height * 0.15
    position = [bb.min.x + padX + markerSize / 2, bb.min.y + padY + markerSize / 2]
  }

  // Geçerlilik: marker tüm köşeleri bounding box içinde mi?
  const half = markerSize / 2
  const corners = [
    [position[0] - half, position[1] - half],
    [position[0] + half, position[1] - half],
    [position[0] - half, position[1] + half],
    [position[0] + half, position[1] + half],
  ]
  const isValid = corners.every(
    ([x, y]) =>
      x >= bb.min.x && x <= bb.max.x && y >= bb.min.y && y <= bb.max.y
  )

  // Rotasyon matrisini Euler'a çevir (derece)
  const euler = new THREE.Euler().setFromRotationMatrix(rotMatrix, 'XYZ')
  const rotation: [number, number, number] = [
    THREE.MathUtils.radToDeg(euler.x),
    THREE.MathUtils.radToDeg(euler.y),
    THREE.MathUtils.radToDeg(euler.z),
  ]

  return { rotation, position, markerSize, etchDepth, isValid, surfaceArea: shortSide }
}

/**
 * Ana preset üretici.
 * STL geometrisini analiz eder, 2 akıllı preset + 1 manuel seçenek döndürür.
 */
export function computePresets(geo: THREE.BufferGeometry): Preset[] {
  const nonIndexed = geo.toNonIndexed()
  nonIndexed.computeVertexNormals()

  const groups = analyzeFaceNormals(nonIndexed)
  const presets: Preset[] = []

  // En büyük 2 yüzey grubundan preset üret
  const topGroups = groups.slice(0, 3)

  for (let gi = 0; gi < topGroups.length && presets.length < 2; gi++) {
    const group = topGroups[gi]
    const rotMatrix = rotationToAlignFaceDown(group.normal)

    // Merkez yerleşim
    const center = computePresetParams(nonIndexed, rotMatrix, 'center')
    if (center.isValid && center.surfaceArea >= 7.2) {
      const isFirst = presets.length === 0
      presets.push({
        id: `auto_center_${gi}`,
        label: isFirst ? 'Taban Merkez' : 'Alternatif Merkez',
        labelEN: isFirst ? 'Base Center' : 'Alternative Center',
        description: isFirst
          ? 'En büyük düz yüzey tespit edildi. FFF baskı için önerilen yerleşim.'
          : 'İkinci büyük düz yüzey.',
        descriptionEN: isFirst
          ? 'Largest flat surface detected. Recommended for FFF printing.'
          : 'Second largest flat surface.',
        badge: isFirst ? 'recommended' : 'alternative',
        ...center,
      })

      // Köşe varyantını da dene
      const corner = computePresetParams(nonIndexed, rotMatrix, 'corner')
      if (corner.isValid && presets.length < 2) {
        presets.push({
          id: `auto_corner_${gi}`,
          label: 'Taban Sol-Alt Köşe',
          labelEN: 'Base Bottom-Left',
          description: 'Aynı yüzey, köşe yerleşimi.',
          descriptionEN: 'Same surface, corner placement.',
          badge: 'alternative',
          ...corner,
        })
      }
    }
  }

  // Manuel seçenek her zaman son
  presets.push({
    id: 'manual',
    label: 'Manuel Yerleşim',
    labelEN: 'Manual Placement',
    description: 'Tüm parametreleri kendin ayarla.',
    descriptionEN: 'Configure all parameters manually.',
    badge: 'manual',
    rotation: [0, 0, 0],
    position: [0, 0],
    markerSize: 10,
    etchDepth: 0.8,
    isValid: true,
  })

  return presets
}

// ─── Ana Gömme Pipeline'ı ──────────────────────────────────────────────────

/**
 * STL geometrisi + placement parametrelerini alır,
 * ArUco işaretini gömer ve sonuç geometriyi döndürür.
 */
export async function embedAruco(
  geo: THREE.BufferGeometry,
  params: PlacementParams
): Promise<THREE.BufferGeometry> {
  const mod = await getManifold()

  // 1. Rotasyonu uygula
  const rotated = geo.clone()
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(params.rotation[0]),
    THREE.MathUtils.degToRad(params.rotation[1]),
    THREE.MathUtils.degToRad(params.rotation[2]),
    'XYZ'
  )
  rotated.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(euler))
  rotated.computeBoundingBox()

  const zMin = rotated.boundingBox!.min.z

  // 2. Parçayı manifold'a çevir
  const partManifold = geometryToManifold(mod, rotated)

  // 3. ArUco manifold'unu üret ve konumlandır
  const arucoManifold = await generateArucoManifold(
    params.markerId,
    params.markerSize,
    params.etchDepth
  )
  // Taban yüzeyine yerleştir: z_min'de ortalanmış (depth*2 yükseklik → her yöne taşıyor)
  const positioned = arucoManifold.translate([
    params.position[0],
    params.position[1],
    zMin + params.etchDepth, // kutu z_min - depth ile z_min + depth arasında
  ])

  // 4. Boolean çıkarma
  const result = partManifold.subtract(positioned)

  // 5. Three.js geometrisine dön
  return manifoldToGeometry(result)
}

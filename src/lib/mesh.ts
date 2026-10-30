/**
 * Mesh analysis, smart preset generation and Three.js ↔ Manifold conversions.
 */

import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { getManifold } from './manifold'
import { generateArucoManifold } from './aruco'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Preset {
  id: string
  label: string
  labelEN: string
  description: string
  descriptionEN: string
  badge: 'recommended' | 'alternative' | 'manual'
  /** Euler angles (degrees) — rotation to apply to the mesh */
  rotation: [number, number, number]
  /** Marker centre in model coordinates after rotation */
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

// ─── STL loading ───────────────────────────────────────────────────────────

const loader = new STLLoader()

export function loadSTLFromBuffer(buffer: ArrayBuffer): THREE.BufferGeometry {
  const geo = loader.parse(buffer)
  geo.computeVertexNormals()
  return geo
}

// ─── Three.js ↔ Manifold conversions ───────────────────────────────────────

export function geometryToManifold(mod: any, geo: THREE.BufferGeometry): any {
  // ── Step 1: toNonIndexed ──────────────────────────────────────────────
  const nonIdx = geo.clone().toNonIndexed()

  // ── Step 2: mergeVertices ─────────────────────────────────────────────
  // CRITICAL: mergeVertices hashes every attribute.
  // If a normal attribute exists, vertices at the same position that belong to
  // different faces have different normals and are not merged → non-manifold mesh.
  // Fix: delete the normals before merging, then recompute them.
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
  if (!idxAttr) throw new Error('Could not index the mesh — mergeVertices failed')
  const triVerts = new Uint32Array(idxAttr.array)

  if (triVerts.length % 3 !== 0) throw new Error(`Index count must be a multiple of 3: ${triVerts.length}`)

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

// ─── Smart preset analysis ─────────────────────────────────────────────────

interface FaceGroup {
  normal: THREE.Vector3
  area: number
}

/** Groups the geometry's face normals, weighted by area */
function analyzeFaceNormals(geo: THREE.BufferGeometry): FaceGroup[] {
  const posAttr = geo.attributes.position
  const normAttr = geo.attributes.normal

  const groups = new Map<string, FaceGroup>()

  for (let i = 0; i < posAttr.count; i += 3) {
    // Face normal: average of the 3 vertex normals
    const nx = (normAttr.getX(i) + normAttr.getX(i + 1) + normAttr.getX(i + 2)) / 3
    const ny = (normAttr.getY(i) + normAttr.getY(i + 1) + normAttr.getY(i + 2)) / 3
    const nz = (normAttr.getZ(i) + normAttr.getZ(i + 1) + normAttr.getZ(i + 2)) / 3
    const n = new THREE.Vector3(nx, ny, nz).normalize()

    // Face area (Heron's formula)
    const a = new THREE.Vector3().fromBufferAttribute(posAttr, i)
    const b = new THREE.Vector3().fromBufferAttribute(posAttr, i + 1)
    const c = new THREE.Vector3().fromBufferAttribute(posAttr, i + 2)
    const area = new THREE.Triangle(a, b, c).getArea()

    // Group normal directions with a 0.15 tolerance
    const key = `${n.x.toFixed(1)},${n.y.toFixed(1)},${n.z.toFixed(1)}`

    if (groups.has(key)) {
      groups.get(key)!.area += area
    } else {
      groups.set(key, { normal: n.clone(), area })
    }
  }

  return [...groups.values()].sort((a, b) => b.area - a.area)
}

/** Returns the rotation matrix that aligns dominant_normal with -Z */
function rotationToAlignFaceDown(dominantNormal: THREE.Vector3): THREE.Matrix4 {
  const target = new THREE.Vector3(0, 0, -1)
  const src = dominantNormal.clone().normalize()

  // Already at -Z?
  if (src.dot(target) > 0.9999) return new THREE.Matrix4()
  // Exactly opposite (+Z)?
  if (src.dot(target) < -0.9999) {
    return new THREE.Matrix4().makeRotationX(Math.PI)
  }

  const axis = new THREE.Vector3().crossVectors(src, target).normalize()
  const angle = Math.acos(Math.max(-1, Math.min(1, src.dot(target))))
  return new THREE.Matrix4().makeRotationAxis(axis, angle)
}

/** Computes preset parameters from the bounding box of the rotated geometry */
function computePresetParams(geo: THREE.BufferGeometry, rotMatrix: THREE.Matrix4, positionVariant: 'center' | 'corner') {
  const rotated = geo.clone()
  rotated.applyMatrix4(rotMatrix)
  rotated.computeBoundingBox()
  const bb = rotated.boundingBox!

  const width = bb.max.x - bb.min.x
  const height = bb.max.y - bb.min.y
  const shortSide = Math.min(width, height)

  // Size: fixed default (the user can change it in the placement controls)
  const markerSize = 10   // fixed 10 × 10 mm
  const etchDepth = 0.8   // engraving depth 0.8 mm

  const cx = (bb.min.x + bb.max.x) / 2
  const cy = (bb.min.y + bb.max.y) / 2

  let position: [number, number]
  if (positionVariant === 'center') {
    position = [cx, cy]
  } else {
    // Bottom-left corner, with padding
    const padX = width * 0.15
    const padY = height * 0.15
    position = [bb.min.x + padX + markerSize / 2, bb.min.y + padY + markerSize / 2]
  }

  // Validity: are all marker corners inside the bounding box?
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

  // Convert the rotation matrix to Euler angles (degrees)
  const euler = new THREE.Euler().setFromRotationMatrix(rotMatrix, 'XYZ')
  const rotation: [number, number, number] = [
    THREE.MathUtils.radToDeg(euler.x),
    THREE.MathUtils.radToDeg(euler.y),
    THREE.MathUtils.radToDeg(euler.z),
  ]

  return { rotation, position, markerSize, etchDepth, isValid, surfaceArea: shortSide }
}

/**
 * Main preset generator.
 * Analyses the STL geometry and returns 2 smart presets + 1 manual option.
 */
export function computePresets(geo: THREE.BufferGeometry): Preset[] {
  const nonIndexed = geo.toNonIndexed()
  nonIndexed.computeVertexNormals()

  const groups = analyzeFaceNormals(nonIndexed)
  const presets: Preset[] = []

  // Build presets from the 2 largest surface groups
  const topGroups = groups.slice(0, 3)

  for (let gi = 0; gi < topGroups.length && presets.length < 2; gi++) {
    const group = topGroups[gi]
    const rotMatrix = rotationToAlignFaceDown(group.normal)

    // Centre placement
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

      // Also try the corner variant
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

  // The manual option always comes last
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

// ─── Main embedding pipeline ───────────────────────────────────────────────

/**
 * Takes the STL geometry + placement parameters,
 * embeds the ArUco marker and returns the resulting geometry.
 */
export async function embedAruco(
  geo: THREE.BufferGeometry,
  params: PlacementParams
): Promise<THREE.BufferGeometry> {
  const mod = await getManifold()

  // 1. Apply the rotation
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

  // 2. Convert the part to a manifold
  const partManifold = geometryToManifold(mod, rotated)

  // 3. Generate and position the ArUco manifold
  const arucoManifold = await generateArucoManifold(
    params.markerId,
    params.markerSize,
    params.etchDepth
  )
  // Place it on the base face: the box is centred at z_min. Being depth*2 tall and
  // centred, it spans [z_min - depth, z_min + depth]; its intersection with the part
  // (z >= z_min) cuts a pocket exactly depth deep. (Adding +etchDepth would make the
  // pocket 2*depth deep → the double-embed bug.)
  const positioned = arucoManifold.translate([
    params.position[0],
    params.position[1],
    zMin, // box centre exactly on the base face
  ])

  // 4. Boolean subtraction
  const result = partManifold.subtract(positioned)

  // 5. Convert back to Three.js geometry
  return manifoldToGeometry(result)
}

/**
 * ArUco marker mesh generator.
 * Reads bit patterns from the pre-generated aruco_dict_4x4_50.json and turns
 * the black cells into a pocket volume: one MERGED 2D region with a stepped
 * inward-offset chamfer.
 * NOTE: 4x4_50 dictionary — high inter-code distance, robust against misreads.
 */

import { getManifold } from './manifold'
import arucoDict from '../assets/aruco_dict_4x4_50.json'

/** Returns the 6×6 bit grid for a marker ID (1=black, 0=white) */
export function getMarkerBits(id: number): number[][] {
  if (id < 0 || id >= arucoDict.length) throw new Error(`Invalid ArUco ID ${id} (valid range: 0–49)`)
  return arucoDict[id] as number[][]
}

/** Number of chamfer steps — at 0.8 mm depth each step ≈ 0.2 mm ≈ a typical layer height */
const CHAMFER_STEPS = 4

/**
 * Builds the ArUco geometry for the Manifold boolean subtraction.
 * Result: a pocket volume that opens at the surface at z=0.
 *
 * Structure:
 *  - The black cell squares (scaled by 1.001 so they overlap) are merged into
 *    ONE 2D region (CrossSection, Positive fill).
 *  - z ∈ [-depth, 0]: merged region at full width (clean cut margin below the surface).
 *  - z ∈ [0, depth]: the region's outer outline is offset inward in CHAMFER_STEPS
 *    steps → the pocket walls narrow like a staircase (printing quantises
 *    to layer height anyway, so the result equals a smooth chamfer).
 *
 * WHY a merged region + offset, and NOT per-cell frustums:
 *  Chamfering each cell produces wedge ridges BETWEEN fused neighbouring black
 *  cells that start at zero width at the bottom and thicken upwards
 *  (e.g. ~0.75 mm at the top, 0 mm at the bottom at 0.8 mm depth). The slicer
 *  turns these knife edges into loose, curling strands → pockets fill with debris
 *  and the cell boundaries are lost (observed on a test print, 2026-07-03).
 *  Offsetting only the OUTER outline of the merged region leaves the interior
 *  fully open; no geometry is created between cells.
 *
 * WHY a chamfer (offset) is still used:
 *  1. When embedding on the bottom face, the pocket ceiling is bridged; the
 *     inward-narrowing wall cuts the remaining bridge span to ~40% → less sagging/stringing.
 *  2. Sloped/stepped walls also cast shadows under wide-angle light → larger
 *     contrast area on single-colour engravings.
 *
 * Usage:
 *   const aruco = await generateArucoManifold(markerId, sizeInMm, depthInMm)
 *   aruco.translate([cx, cy, z_min])  → object to subtract from the part
 */
export async function generateArucoManifold(
  markerId: number,
  size: number,   // total size in mm (e.g. 15)
  depth: number,  // engraving depth in mm (e.g. 0.6)
) {
  const { Manifold, CrossSection } = await getManifold()
  const bits = getMarkerBits(markerId)

  const cellSize = size / 6
  const offset = size / 2

  // 1.001 factor: neighbouring black cells must overlap → a single region after union.
  // (Shrinking by 0.999 left micron-thin walls between neighbours.)
  const half = (cellSize * 1.001) / 2

  const polygons: Array<Array<[number, number]>> = []
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      if (bits[row][col] !== 1) continue
      const cx = col * cellSize + cellSize / 2 - offset
      const cy = -(row * cellSize + cellSize / 2 - offset) // flip the Y axis
      polygons.push([
        [cx - half, cy - half], [cx + half, cy - half],
        [cx + half, cy + half], [cx - half, cy + half],
      ])
    }
  }
  if (polygons.length === 0) throw new Error('ArUco marker contains no black cells')

  // Overlapping squares merge into a single region with Positive fill
  const region = new CrossSection(polygons, 'Positive')

  // Wall chamfer: total inward narrowing from the outer outline. Capped at 30% so
  // the ceiling bridge of a single cell doesn't get narrower than 40% of the cell.
  const inset = Math.min(depth, cellSize * 0.3)

  // Lower half: z ∈ [-depth, 0] at full width — clean cut margin below the surface
  let result: any = Manifold.extrude(region.toPolygons(), depth).translate([0, 0, -depth])

  // Upper half: stepped inward offset (full width at the surface, -inset at z=depth)
  const stepH = depth / CHAMFER_STEPS
  for (let k = 0; k < CHAMFER_STEPS; k++) {
    const shrunk = k === 0 ? region : region.offset(-(inset * k) / CHAMFER_STEPS, 'Miter')
    if (shrunk.area() < 1e-6) break // region fully closed — remaining steps are empty
    const slab = Manifold.extrude(shrunk.toPolygons(), stepH).translate([0, 0, k * stepH])
    result = result.add(slab)
  }

  return result
}

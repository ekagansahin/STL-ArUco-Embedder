/**
 * Exports geometry as STL.
 */

import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'

const exporter = new STLExporter()

/** Converts geometry to a binary STL ArrayBuffer — for saving or downloading. */
export function geometryToSTLBuffer(geo: THREE.BufferGeometry): ArrayBuffer {
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
  const dataView = exporter.parse(mesh, { binary: true }) as unknown as DataView
  // Copy the bytes into a guaranteed ArrayBuffer (avoids the SharedArrayBuffer type mismatch)
  const src = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength)
  const dst = new ArrayBuffer(src.byteLength)
  new Uint8Array(dst).set(src)
  return dst
}

/** Downloads geometry as a binary STL file. */
export function exportSTL(geo: THREE.BufferGeometry, filename: string) {
  const buffer = geometryToSTLBuffer(geo)
  const blob = new Blob([buffer], { type: 'application/octet-stream' })
  triggerDownload(blob, filename.endsWith('.stl') ? filename : filename + '.stl')
}

/** Downloads an ArrayBuffer as a file. */
export function downloadBuffer(buffer: ArrayBuffer, filename: string) {
  const blob = new Blob([buffer], { type: 'application/octet-stream' })
  triggerDownload(blob, filename)
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Geometriyi STL olarak dışa aktarır.
 */

import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'

const exporter = new STLExporter()

/** Geometriyi binary STL ArrayBuffer'a çevirir — kaydetmek veya indirmek için. */
export function geometryToSTLBuffer(geo: THREE.BufferGeometry): ArrayBuffer {
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
  const dataView = exporter.parse(mesh, { binary: true }) as unknown as DataView
  // DataView'ın altındaki buffer'ı kopyala (paylaşımlı hafıza sorununu önler)
  const buf = dataView.buffer
  const plain = buf instanceof SharedArrayBuffer ? buf.slice(0) : buf as ArrayBuffer
  return plain.slice(dataView.byteOffset, dataView.byteOffset + dataView.byteLength)
}

/** Geometriyi binary STL olarak indirir. */
export function exportSTL(geo: THREE.BufferGeometry, filename: string) {
  const buffer = geometryToSTLBuffer(geo)
  const blob = new Blob([buffer], { type: 'application/octet-stream' })
  triggerDownload(blob, filename.endsWith('.stl') ? filename : filename + '.stl')
}

/** ArrayBuffer'ı dosya olarak indirir. */
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

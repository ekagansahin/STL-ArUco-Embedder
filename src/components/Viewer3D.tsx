/**
 * Three.js 3D önizleme bileşeni.
 * - STL mesh yarı saydam gri
 * - ArUco yerleşim kutusu kırmızı
 * - Orbit controls: sol tık döndür, sağ tık pan, scroll zoom
 */

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

interface Viewer3DProps {
  geometry: THREE.BufferGeometry | null
  markerX: number
  markerY: number
  markerSize: number
  etchDepth: number
  rotation: [number, number, number]
}

export default function Viewer3D({
  geometry,
  markerX,
  markerY,
  markerSize,
  etchDepth,
  rotation,
}: Viewer3DProps) {
  const mountRef      = useRef<HTMLDivElement>(null)
  const sceneRef      = useRef<THREE.Scene | null>(null)
  const rendererRef   = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef     = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef   = useRef<OrbitControls | null>(null)
  const meshRef       = useRef<THREE.Mesh | null>(null)
  const markerBoxRef  = useRef<THREE.Mesh | null>(null)
  const frameRef      = useRef<number>(0)

  // ── Sahneyi bir kez kur ────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current!

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#141414')
    sceneRef.current = scene

    // Aspect ratio 1 ile başla — ResizeObserver hemen düzeltecek
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000)
    camera.position.set(0, -200, 150)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(1, 1) // ResizeObserver anında düzeltir
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controlsRef.current = controls

    // Işıklar
    scene.add(new THREE.AmbientLight('#ffffff', 0.7))
    const dir = new THREE.DirectionalLight('#ffffff', 1.2)
    dir.position.set(100, 100, 200)
    scene.add(dir)
    const dir2 = new THREE.DirectionalLight('#6699ff', 0.4)
    dir2.position.set(-100, -100, -50)
    scene.add(dir2)

    // Grid
    const grid = new THREE.GridHelper(400, 40, '#222222', '#1a1a1a')
    scene.add(grid)

    // Render döngüsü
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    // ResizeObserver: ilk boyut + sonraki resize'ları yakala
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width < 1 || height < 1) continue
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setSize(width, height)
      }
    })
    ro.observe(mount)

    return () => {
      cancelAnimationFrame(frameRef.current)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [])

  // ── Geometri değişince mesh'i güncelle ────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    if (meshRef.current) {
      scene.remove(meshRef.current)
      meshRef.current.geometry.dispose()
      meshRef.current = null
    }

    if (!geometry) return

    // Rotasyonu uygula
    const rotated = geometry.clone()
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(rotation[0]),
      THREE.MathUtils.degToRad(rotation[1]),
      THREE.MathUtils.degToRad(rotation[2]),
      'XYZ'
    )
    rotated.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(euler))

    // Tabanı grid'e otur
    rotated.computeBoundingBox()
    const zMin = rotated.boundingBox!.min.z
    rotated.translate(0, 0, -zMin)

    const mat = new THREE.MeshPhongMaterial({
      color: '#888888',
      opacity: 0.85,
      transparent: true,
      side: THREE.DoubleSide,
      shininess: 40,
    })
    const mesh = new THREE.Mesh(rotated, mat)
    scene.add(mesh)
    meshRef.current = mesh

    // Kamerayı parçaya odakla
    rotated.computeBoundingBox()
    const bb    = rotated.boundingBox!
    const center = new THREE.Vector3()
    bb.getCenter(center)
    const size = bb.getSize(new THREE.Vector3()).length()

    const camera   = cameraRef.current!
    const controls = controlsRef.current!
    controls.target.copy(center)
    camera.position.set(center.x, center.y - size * 1.5, center.z + size * 0.8)
    camera.near = size * 0.001
    camera.far  = size * 100
    camera.updateProjectionMatrix()
    controls.update()
  }, [geometry, rotation])

  // ── Marker kutusu pozisyonunu güncelle ────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    if (markerBoxRef.current) {
      scene.remove(markerBoxRef.current)
      markerBoxRef.current.geometry.dispose()
      markerBoxRef.current = null
    }

    if (!geometry) return

    // z_min'i hesapla
    const rotated = geometry.clone()
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(rotation[0]),
      THREE.MathUtils.degToRad(rotation[1]),
      THREE.MathUtils.degToRad(rotation[2]),
      'XYZ'
    )
    rotated.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(euler))
    rotated.computeBoundingBox()
    // Mesh effect'te translate(0,0,-zMin) ile taban Z=0'a oturtuluyor.
    // Marker kutusu da Z=0 (taban) baz alınarak konumlandırılmalı.
    const boxGeo = new THREE.BoxGeometry(markerSize, markerSize, etchDepth)
    const boxMat = new THREE.MeshPhongMaterial({
      color: '#ef4444',
      opacity: 0.75,
      transparent: true,
    })
    const box = new THREE.Mesh(boxGeo, boxMat)
    box.position.set(markerX, markerY, etchDepth / 2)
    scene.add(box)
    markerBoxRef.current = box
  }, [geometry, markerX, markerY, markerSize, etchDepth, rotation])

  return (
    <div
      ref={mountRef}
      className="w-full h-full"
      style={{ minHeight: 300 }}
    />
  )
}

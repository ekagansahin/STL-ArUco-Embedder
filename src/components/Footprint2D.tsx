/**
 * 2D üstten görünüm — "footprint haritası".
 * Mesh'in XY projeksiyonu (gri dolgu) + ArUco karesi (kırmızı).
 * Kullanıcı sürükleyerek marker'ı konumlandırabilir.
 */

import { useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'

interface Footprint2DProps {
  geometry: THREE.BufferGeometry | null
  rotation: [number, number, number]
  markerX: number
  markerY: number
  markerSize: number
  onChange: (x: number, y: number) => void
}

export default function Footprint2D({
  geometry,
  rotation,
  markerX,
  markerY,
  markerSize,
  onChange,
}: Footprint2DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boundsRef = useRef({ minX: 0, maxX: 1, minY: 0, maxY: 1 })
  const draggingRef = useRef(false)

  // Dünya koordinatı → canvas piksel
  const worldToCanvas = useCallback(
    (wx: number, wy: number, canvasW: number, canvasH: number) => {
      const { minX, maxX, minY, maxY } = boundsRef.current
      const pad = 20
      const scaleX = (canvasW - pad * 2) / (maxX - minX || 1)
      const scaleY = (canvasH - pad * 2) / (maxY - minY || 1)
      const scale = Math.min(scaleX, scaleY)
      const cx = canvasW / 2
      const cy = canvasH / 2
      const midX = (minX + maxX) / 2
      const midY = (minY + maxY) / 2
      return {
        x: cx + (wx - midX) * scale,
        y: cy - (wy - midY) * scale, // Y ekranı ters
      }
    },
    []
  )

  // Canvas piksel → dünya koordinatı
  const canvasToWorld = useCallback(
    (px: number, py: number, canvasW: number, canvasH: number) => {
      const { minX, maxX, minY, maxY } = boundsRef.current
      const pad = 20
      const scaleX = (canvasW - pad * 2) / (maxX - minX || 1)
      const scaleY = (canvasH - pad * 2) / (maxY - minY || 1)
      const scale = Math.min(scaleX, scaleY)
      const cx = canvasW / 2
      const cy = canvasH / 2
      const midX = (minX + maxX) / 2
      const midY = (minY + maxY) / 2
      return {
        wx: midX + (px - cx) / scale,
        wy: midY - (py - cy) / scale,
      }
    },
    []
  )

  // Çizim
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !geometry) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width
    const H = canvas.height

    ctx.clearRect(0, 0, W, H)

    // Arka plan
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, W, H)

    // Mesh kontur (bounding box yerine tüm XY noktaları)
    const rotated = geometry.clone()
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(rotation[0]),
      THREE.MathUtils.degToRad(rotation[1]),
      THREE.MathUtils.degToRad(rotation[2]),
      'XYZ'
    )
    rotated.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(euler))
    rotated.computeBoundingBox()
    const bb = rotated.boundingBox!
    boundsRef.current = { minX: bb.min.x, maxX: bb.max.x, minY: bb.min.y, maxY: bb.max.y }

    // Mesh dolgusu (bounding box olarak basitleştirilmiş)
    const tl = worldToCanvas(bb.min.x, bb.max.y, W, H)
    const br = worldToCanvas(bb.max.x, bb.min.y, W, H)
    ctx.fillStyle = '#2d2d2d'
    ctx.strokeStyle = '#555555'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)
    ctx.fill()
    ctx.stroke()

    // Mesh etiketi
    ctx.fillStyle = '#555'
    ctx.font = '11px monospace'
    ctx.fillText(`${(bb.max.x - bb.min.x).toFixed(1)} mm`, tl.x + 4, br.y - 4)

    // ArUco marker kutusunu çiz
    const half = markerSize / 2
    const { minX, maxX, minY, maxY } = boundsRef.current
    const outOfBounds =
      markerX - half < minX || markerX + half > maxX ||
      markerY - half < minY || markerY + half > maxY

    const mc = worldToCanvas(markerX, markerY, W, H)
    const mTl = worldToCanvas(markerX - half, markerY + half, W, H)
    const mBr = worldToCanvas(markerX + half, markerY - half, W, H)
    const mW = mBr.x - mTl.x
    const mH = mBr.y - mTl.y

    ctx.fillStyle = outOfBounds ? 'rgba(239,68,68,0.25)' : 'rgba(239,68,68,0.35)'
    ctx.strokeStyle = outOfBounds ? '#ef4444' : '#f87171'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(mTl.x, mTl.y, mW, mH)
    ctx.fill()
    ctx.stroke()

    // Marker merkez
    ctx.fillStyle = outOfBounds ? '#ef4444' : '#f87171'
    ctx.beginPath()
    ctx.arc(mc.x, mc.y, 3, 0, Math.PI * 2)
    ctx.fill()

    // Uyarı
    if (outOfBounds) {
      ctx.fillStyle = '#ef4444'
      ctx.font = 'bold 12px sans-serif'
      ctx.fillText('⚠ Sınır dışı', 10, 22)
    }

    // Ölçek çubuğu
    const scaleLen = 10 // mm
    const p1 = worldToCanvas(bb.min.x + 2, bb.min.y + 4, W, H)
    const p2 = worldToCanvas(bb.min.x + 2 + scaleLen, bb.min.y + 4, W, H)
    ctx.strokeStyle = '#888'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p1.y)
    ctx.stroke()
    ctx.fillStyle = '#888'
    ctx.font = '10px monospace'
    ctx.fillText(`${scaleLen}mm`, p1.x, p1.y - 3)
  }, [geometry, rotation, markerX, markerY, markerSize, worldToCanvas])

  useEffect(() => {
    draw()
  }, [draw])

  // Canvas boyutunu ayarla
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
      draw()
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [draw])

  // Sürükleme
  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    let clientX: number, clientY: number
    if ('touches' in e) {
      clientX = e.touches[0].clientX
      clientY = e.touches[0].clientY
    } else {
      clientX = e.clientX
      clientY = e.clientY
    }
    return canvasToWorld(clientX - rect.left, clientY - rect.top, canvas.width, canvas.height)
  }

  const onMouseDown = (e: React.MouseEvent) => {
    draggingRef.current = true
    const { wx, wy } = getPos(e)
    onChange(wx, wy)
  }
  const onMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return
    const { wx, wy } = getPos(e)
    onChange(wx, wy)
  }
  const onMouseUp = () => { draggingRef.current = false }

  return (
    <div className="w-full rounded-xl overflow-hidden border border-neutral-800 relative" style={{ height: 220 }}>
      <div className="absolute top-2 left-2 text-xs text-neutral-500 z-10 pointer-events-none">
        Üstten Görünüm · Tıkla veya Sürükle
      </div>
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      />
    </div>
  )
}

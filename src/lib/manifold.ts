/**
 * manifold-3d WASM sarmalayıcı.
 * Singleton pattern: WASM modülü bir kez yüklenir, sonraki çağrılarda önbellekten döner.
 */

let _manifold: any = null

export async function getManifold() {
  if (_manifold) return _manifold
  const Module = (await import('manifold-3d')).default
  const wasm = await Module()
  // ZORUNLU: setup() çağrılmadan Mesh/Manifold constructor'ları çalışmıyor
  wasm.setup()
  _manifold = wasm
  return _manifold
}

export type ManifoldModule = Awaited<ReturnType<typeof getManifold>>

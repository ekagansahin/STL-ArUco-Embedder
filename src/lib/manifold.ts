/**
 * manifold-3d WASM wrapper.
 * Singleton: the WASM module is loaded once and served from cache on later calls.
 */

let _manifold: any = null

export async function getManifold() {
  if (_manifold) return _manifold
  const Module = (await import('manifold-3d')).default
  const wasm = await Module()
  // REQUIRED: the Mesh/Manifold constructors don't work until setup() has been called
  wasm.setup()
  _manifold = wasm
  return _manifold
}

export type ManifoldModule = Awaited<ReturnType<typeof getManifold>>

/**
 * Copies MediaPipe FaceMesh WASM/model assets from node_modules to public/
 * so the browser can load them without depending on an external CDN.
 *
 * Run automatically via "predev" and "prebuild" in package.json.
 */
import { cpSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const src  = resolve(root, 'node_modules/@mediapipe/face_mesh');
const dest = resolve(root, 'public/mediapipe/face_mesh');

if (!existsSync(src)) {
  console.warn('[copy-mediapipe] @mediapipe/face_mesh not found in node_modules — skipping');
  process.exit(0);
}

mkdirSync(dest, { recursive: true });

const files = [
  'face_mesh.binarypb',
  'face_mesh_solution_packed_assets.data',
  'face_mesh_solution_packed_assets_loader.js',
  'face_mesh_solution_simd_wasm_bin.data',
  'face_mesh_solution_simd_wasm_bin.js',
  'face_mesh_solution_simd_wasm_bin.wasm',
  'face_mesh_solution_wasm_bin.js',
  'face_mesh_solution_wasm_bin.wasm',
];

for (const f of files) {
  const from = resolve(src, f);
  const to   = resolve(dest, f);
  if (!existsSync(from)) { console.warn(`[copy-mediapipe] missing: ${f}`); continue; }
  cpSync(from, to);
  console.log(`[copy-mediapipe] copied ${f}`);
}

console.log('[copy-mediapipe] done →', dest);

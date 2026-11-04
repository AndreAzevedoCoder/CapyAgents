/**
 * Gera assets/bear-optimized.glb: versão decimada do urso (178k -> ~18k
 * vértices) para manter 60 fps com 20+ agentes. O servidor serve a versão
 * otimizada quando ela existe; o original permanece intacto.
 */
import { NodeIO } from '@gltf-transform/core';
import { simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets', 'Meshy_AI_Sunny_Fluffbear_1103224035_texture.glb');
const DST = path.join(ROOT, 'assets', 'bear-optimized.glb');

if (!fs.existsSync(SRC)) {
  console.error(`✗ não encontrei ${SRC}`);
  process.exit(1);
}
if (fs.existsSync(DST) && fs.statSync(DST).mtimeMs > fs.statSync(SRC).mtimeMs) {
  console.log('✓ assets/bear-optimized.glb já está atualizado');
  process.exit(0);
}

const io = new NodeIO();
const doc = await io.read(SRC);
await MeshoptSimplifier.ready;
await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.1, error: 0.002 }),
);

let verts = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    verts += prim.getAttribute('POSITION')?.getCount() ?? 0;
  }
}
await io.write(DST, doc);
const mb = (fs.statSync(DST).size / 1024 / 1024).toFixed(1);
console.log(`✓ assets/bear-optimized.glb (${verts} vértices, ${mb} MB)`);

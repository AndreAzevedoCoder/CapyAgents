/**
 * Gera chapéus de exemplo (.glb) proceduralmente em assets/hats/.
 * Nenhum asset externo: geometria de cilindros/cones com cores sólidas.
 * Para adicionar um chapéu próprio, basta colocar um .glb na pasta e
 * (opcionalmente) ajustar posição/rotação/escala em assets/hats/hats.json.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HATS_DIR = path.join(ROOT, 'assets', 'hats');
fs.mkdirSync(HATS_DIR, { recursive: true });

interface Mesh {
  positions: number[];
  normals: number[];
  indices: number[];
}

/** Cilindro/cone (radiusTop pode ser 0) com tampas, centrado em x/z, base em y0. */
function cylinder(
  radiusBottom: number,
  radiusTop: number,
  height: number,
  y0: number,
  segments = 24,
): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const slope = (radiusBottom - radiusTop) / height;

  // lateral
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const nLen = Math.hypot(1, slope);
    for (const [r, y] of [
      [radiusBottom, y0],
      [radiusTop, y0 + height],
    ] as const) {
      positions.push(cos * r, y, sin * r);
      normals.push(cos / nLen, slope / nLen, sin / nLen);
    }
  }
  for (let i = 0; i < segments; i++) {
    const b = i * 2;
    indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }

  // tampas
  for (const [r, y, ny] of [
    [radiusBottom, y0, -1],
    [radiusTop, y0 + height, 1],
  ] as const) {
    if (r <= 0.0001) continue;
    const center = positions.length / 3;
    positions.push(0, y, 0);
    normals.push(0, ny, 0);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(Math.cos(a) * r, y, Math.sin(a) * r);
      normals.push(0, ny, 0);
    }
    for (let i = 0; i < segments; i++) {
      if (ny > 0) indices.push(center, center + 1 + i, center + 2 + i);
      else indices.push(center, center + 2 + i, center + 1 + i);
    }
  }
  return { positions, normals, indices };
}

function mergeMeshes(meshes: Mesh[]): Mesh {
  const out: Mesh = { positions: [], normals: [], indices: [] };
  for (const m of meshes) {
    const offset = out.positions.length / 3;
    out.positions.push(...m.positions);
    out.normals.push(...m.normals);
    out.indices.push(...m.indices.map((i) => i + offset));
  }
  return out;
}

async function writeHat(name: string, color: [number, number, number], mesh: Mesh): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(mesh.positions))
    .setBuffer(buffer);
  const normal = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(mesh.normals))
    .setBuffer(buffer);
  const indices = doc
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Uint16Array(mesh.indices))
    .setBuffer(buffer);
  const material = doc
    .createMaterial(name)
    .setBaseColorFactor([...color, 1])
    .setMetallicFactor(0.05)
    .setRoughnessFactor(0.85);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('NORMAL', normal)
    .setIndices(indices)
    .setMaterial(material);
  const gltfMesh = doc.createMesh(name).addPrimitive(prim);
  const node = doc.createNode(name).setMesh(gltfMesh);
  doc.createScene(name).addChild(node);

  const file = path.join(HATS_DIR, `${name}.glb`);
  await new NodeIO().write(file, doc);
  console.log(`✓ ${path.relative(ROOT, file)}`);
}

// Dimensões pensadas para uma cabeça de ~0.5 de raio (ajuste fino em hats.json).
const hats: Array<{ name: string; color: [number, number, number]; mesh: Mesh }> = [
  {
    name: 'cowboy',
    color: [0.45, 0.29, 0.14],
    mesh: mergeMeshes([
      cylinder(0.62, 0.6, 0.04, 0), // aba larga
      cylinder(0.34, 0.28, 0.3, 0.04), // copa
    ]),
  },
  {
    name: 'wizard',
    color: [0.25, 0.2, 0.6],
    mesh: mergeMeshes([
      cylinder(0.52, 0.5, 0.04, 0), // aba
      cylinder(0.32, 0.0, 0.62, 0.04, 20), // cone
    ]),
  },
  {
    name: 'tophat',
    color: [0.12, 0.12, 0.14],
    mesh: mergeMeshes([
      cylinder(0.52, 0.5, 0.04, 0),
      cylinder(0.3, 0.3, 0.46, 0.04),
    ]),
  },
  {
    name: 'party',
    color: [0.95, 0.35, 0.2],
    mesh: cylinder(0.3, 0.0, 0.5, 0, 16),
  },
  {
    name: 'beret',
    color: [0.75, 0.12, 0.2],
    mesh: mergeMeshes([cylinder(0.4, 0.46, 0.08, 0), cylinder(0.46, 0.1, 0.1, 0.08)]),
  },
];

const adjustments: Record<string, { position: number[]; rotation: number[]; scale: number }> = {
  cowboy: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  wizard: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  tophat: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  party: { position: [0, 0.02, 0], rotation: [0, 0, -0.15], scale: 1 },
  beret: { position: [0.03, 0, 0], rotation: [0, 0, -0.2], scale: 1 },
};

for (const hat of hats) {
  await writeHat(hat.name, hat.color, hat.mesh);
}
const adjFile = path.join(HATS_DIR, 'hats.json');
if (!fs.existsSync(adjFile)) {
  fs.writeFileSync(adjFile, JSON.stringify(adjustments, null, 2) + '\n');
  console.log('✓ assets/hats/hats.json');
}

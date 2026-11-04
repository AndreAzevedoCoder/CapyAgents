import fs from 'node:fs';
import path from 'node:path';
import type { HatInfo } from '@capyagents/shared';
import { ASSETS_DIR } from '../env.js';

const HATS_DIR = path.join(ASSETS_DIR, 'hats');

/**
 * Chapéus disponíveis: qualquer .glb em assets/hats/.
 * Ajustes finos (posição/rotação/escala) vêm de assets/hats/hats.json, opcional:
 *   { "cowboy": { "position": [0, 0.05, 0], "rotation": [0, 0, 0], "scale": 1.1 } }
 */
export function listHats(): HatInfo[] {
  if (!fs.existsSync(HATS_DIR)) return [];
  let adjustments: Record<string, Partial<HatInfo>> = {};
  const adjFile = path.join(HATS_DIR, 'hats.json');
  if (fs.existsSync(adjFile)) {
    try {
      adjustments = JSON.parse(fs.readFileSync(adjFile, 'utf8'));
    } catch (err) {
      console.warn(`assets/hats/hats.json inválido: ${err instanceof Error ? err.message : err}`);
    }
  }
  return fs
    .readdirSync(HATS_DIR)
    .filter((f) => f.endsWith('.glb'))
    .map((f) => {
      const id = f.replace(/\.glb$/, '');
      const adj = adjustments[id] ?? {};
      return {
        id,
        file: `hats/${f}`,
        position: adj.position ?? [0, 0, 0],
        rotation: adj.rotation ?? [0, 0, 0],
        scale: adj.scale ?? 1,
      };
    });
}

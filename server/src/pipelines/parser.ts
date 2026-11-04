import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { PipelineDef } from '@capyagents/shared';
import { PIPELINES_DIR } from '../env.js';

const stepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    agent: z.string(),
    task: z.string(),
    depends_on: z.array(z.string()).default([]),
    inputs: z.array(z.string()).default([]),
    outputs: z.array(z.string()).default([]),
    human_approval: z.boolean().default(false),
    done_when: z.string().nullable().default(null),
    retries: z.number().int().min(0).max(5).default(1),
    worktree: z.boolean().default(false),
    merge: z.boolean().default(false),
  })
  .strict();

const pipelineSchema = z
  .object({
    name: z.string(),
    description: z.string().default(''),
    steps: z.array(stepSchema).min(1),
  })
  .strict();

export class PipelineValidationError extends Error {
  constructor(file: string, issues: string[]) {
    super(`Pipeline inválida em ${file}:\n  - ${issues.join('\n  - ')}`);
  }
}

export function parsePipeline(file: string, raw: string): PipelineDef {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new PipelineValidationError(file, [
      `YAML inválido: ${err instanceof Error ? err.message : err}`,
    ]);
  }
  const parsed = pipelineSchema.safeParse(data);
  if (!parsed.success) {
    throw new PipelineValidationError(
      file,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`),
    );
  }
  const def = parsed.data as PipelineDef;

  const ids = new Set(def.steps.map((s) => s.id));
  if (ids.size !== def.steps.length) {
    throw new PipelineValidationError(file, ['ids de etapas duplicados']);
  }
  for (const step of def.steps) {
    for (const dep of step.depends_on) {
      if (!ids.has(dep)) {
        throw new PipelineValidationError(file, [
          `etapa "${step.id}" depende de "${dep}", que não existe`,
        ]);
      }
    }
  }
  assertAcyclic(file, def);
  return def;
}

function assertAcyclic(file: string, def: PipelineDef): void {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const visit = (id: string, chain: string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new PipelineValidationError(file, [
        `ciclo de dependências: ${[...chain, id].join(' -> ')}`,
      ]);
    }
    visiting.add(id);
    for (const dep of byId.get(id)!.depends_on) visit(dep, [...chain, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const s of def.steps) visit(s.id, []);
}

export function loadPipelines(): Map<string, PipelineDef> {
  const out = new Map<string, PipelineDef>();
  if (!fs.existsSync(PIPELINES_DIR)) return out;
  for (const f of fs.readdirSync(PIPELINES_DIR)) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    const file = path.join(PIPELINES_DIR, f);
    const def = parsePipeline(file, fs.readFileSync(file, 'utf8'));
    out.set(def.name, def);
  }
  return out;
}

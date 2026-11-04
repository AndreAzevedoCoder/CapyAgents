import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentConfig, AgentDefinition, ModelInfo } from '@agent-office/shared';
import { AGENTS_DIR, CONFIG_DIR } from '../env.js';

const configSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'use apenas letras minúsculas, números e hífens'),
    model: z.string().min(1),
    instances: z.number().int().min(1).max(20).default(1),
    hat: z.string().default('none'),
    tools: z
      .object({
        allow: z.array(z.string()).default([]),
        deny: z.array(z.string()).default([]),
        // Comandos de shell negados mesmo com "bash" permitido (ex.: ls, cat,
        // find). A negação é local e instantânea — não vai ao aprovador.
        deny_commands: z.array(z.string()).default([]),
      })
      .default({ allow: [], deny: [], deny_commands: [] }),
    paths: z
      .object({
        allow: z.array(z.string()).default([]),
        deny: z.array(z.string()).default([]),
      })
      .default({ allow: [], deny: [] }),
    can_talk_to: z.array(z.string()).default([]),
    requires_approval_from: z.record(z.string(), z.string()).default({}),
    max_turns: z.number().int().min(1).max(500).default(80),
  })
  .strict();

export class AgentValidationError extends Error {
  constructor(
    public file: string,
    public issues: string[],
  ) {
    super(`Configuração inválida em ${file}:\n  - ${issues.join('\n  - ')}`);
  }
}

export function loadModels(): ModelInfo[] {
  const file = path.join(CONFIG_DIR, 'models.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error(`${file}: esperado um array "models" não vazio`);
  }
  return raw.models as ModelInfo[];
}

/** Carrega e valida todos os agentes de agents/<nome>/. Erros são agregados e claros. */
export function loadAgents(models: ModelInfo[]): Map<string, AgentDefinition> {
  const defs = new Map<string, AgentDefinition>();
  const errors: string[] = [];
  if (!fs.existsSync(AGENTS_DIR)) return defs;

  const dirs = fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const dir of dirs) {
    try {
      defs.set(dir, loadAgent(dir, models));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Validação cruzada: can_talk_to e requires_approval_from referenciam agentes existentes.
  for (const def of defs.values()) {
    const cfgFile = path.join(AGENTS_DIR, def.config.name, 'agent.json');
    for (const other of def.config.can_talk_to) {
      if (other !== 'human' && !defs.has(other)) {
        errors.push(`${cfgFile}: can_talk_to referencia agente inexistente "${other}"`);
      }
    }
    for (const [tool, approver] of Object.entries(def.config.requires_approval_from)) {
      if (approver !== 'human' && !defs.has(approver)) {
        errors.push(
          `${cfgFile}: requires_approval_from.${tool} referencia agente inexistente "${approver}"`,
        );
      }
    }
  }

  if (errors.length) {
    throw new AgentValidationError('agents/', errors);
  }
  return defs;
}

export function loadAgent(name: string, models: ModelInfo[]): AgentDefinition {
  const dir = path.join(AGENTS_DIR, name);
  const jsonFile = path.join(dir, 'agent.json');
  const mdFile = path.join(dir, 'AGENT.md');

  if (!fs.existsSync(jsonFile)) {
    throw new AgentValidationError(jsonFile, ['arquivo agent.json não encontrado']);
  }
  if (!fs.existsSync(mdFile)) {
    throw new AgentValidationError(mdFile, ['arquivo AGENT.md não encontrado']);
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } catch (err) {
    throw new AgentValidationError(jsonFile, [
      `JSON inválido: ${err instanceof Error ? err.message : err}`,
    ]);
  }

  const parsed = configSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new AgentValidationError(
      jsonFile,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`),
    );
  }
  const config = parsed.data as AgentConfig;

  if (config.name !== name) {
    throw new AgentValidationError(jsonFile, [
      `"name" (${config.name}) deve ser igual ao nome da pasta (${name})`,
    ]);
  }
  if (!models.some((m) => m.id === config.model)) {
    throw new AgentValidationError(jsonFile, [
      `modelo "${config.model}" não está em config/models.json (disponíveis: ${models
        .map((m) => m.id)
        .join(', ')})`,
    ]);
  }

  const instructions = fs.readFileSync(mdFile, 'utf8');
  return { config, instructions };
}

/** Grava (cria ou edita) um agente em disco, validando antes. */
export function saveAgent(
  config: AgentConfig,
  instructions: string,
  models: ModelInfo[],
): AgentDefinition {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new AgentValidationError(
      `agents/${config?.name ?? '?'}/agent.json`,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`),
    );
  }
  if (!models.some((m) => m.id === parsed.data.model)) {
    throw new AgentValidationError(`agents/${config.name}/agent.json`, [
      `modelo "${parsed.data.model}" não está em config/models.json`,
    ]);
  }
  const dir = path.join(AGENTS_DIR, parsed.data.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(parsed.data, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'AGENT.md'), instructions);
  return { config: parsed.data as AgentConfig, instructions };
}

export function deleteAgent(name: string): void {
  const dir = path.join(AGENTS_DIR, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

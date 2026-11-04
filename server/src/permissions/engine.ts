import path from 'node:path';
import fs from 'node:fs';
import type { AgentConfig } from '@capyagents/shared';

/**
 * Motor de permissões. É a ÚNICA fonte de decisão sobre o que um agente pode
 * fazer — aplicado no backend antes de cada ferramenta e de cada mensagem.
 * O AGENT.md nunca amplia o que o agent.json define.
 */

/** Grupos amigáveis usados no agent.json -> ferramentas do SDK. */
export const TOOL_GROUPS: Record<string, string[]> = {
  read: ['Read', 'Glob', 'Grep', 'LS'],
  edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  bash: ['Bash', 'BashOutput', 'KillShell', 'KillBash'],
  web: ['WebFetch', 'WebSearch'],
};

/** Ferramentas sempre permitidas: barramento (regulado por can_talk_to) e todo-list interna. */
const ALWAYS_ALLOWED_PREFIXES = ['mcp__bus__'];
const ALWAYS_ALLOWED = new Set(['TodoWrite', 'Task']);
// Task (subagentes) é sempre negado: cada agente é um único processo controlado.
ALWAYS_ALLOWED.delete('Task');

export function groupOfTool(sdkToolName: string): string | null {
  for (const [group, tools] of Object.entries(TOOL_GROUPS)) {
    if (tools.includes(sdkToolName)) return group;
  }
  return null;
}

/** Expande grupos amigáveis em nomes de ferramentas do SDK. */
export function expandToolGroups(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    for (const t of TOOL_GROUPS[n] ?? [n]) out.add(t);
  }
  return [...out];
}

export interface Decision {
  allowed: boolean;
  reason: string;
  /** Preenchido quando a ferramenta exige aprovação de outro agente/humano. */
  needsApprovalFrom?: string;
}

const allow = (reason: string): Decision => ({ allowed: true, reason });
const deny = (reason: string): Decision => ({ allowed: false, reason });

const BASH_TOOLS = new Set(TOOL_GROUPS.bash);

/**
 * Extrai os nomes de comando invocados numa linha de shell, considerando
 * pipes e encadeamentos (| && || ; ). Ex.: "cat x | grep y" -> ["cat", "grep"].
 * Ignora atribuições de ambiente no início (ex.: FOO=1 ls).
 */
export function commandNames(command: string): string[] {
  const names: string[] = [];
  for (const segment of command.split(/\||&&|\|\||;|\n/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let first = tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (!first) continue;
    // nome base do binário (ex.: /bin/ls -> ls)
    first = first.split('/').pop() ?? first;
    names.push(first);
  }
  return names;
}

/** Verifica se a chamada de Bash usa algum comando em tools.deny_commands. */
export function checkDeniedCommand(
  config: AgentConfig,
  toolName: string,
  input: Record<string, unknown>,
): Decision | null {
  if (!BASH_TOOLS.has(toolName)) return null;
  const denied = config.tools.deny_commands ?? [];
  if (denied.length === 0) return null;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) return null;
  const used = commandNames(command);
  const hit = used.find((c) => denied.includes(c));
  if (hit) {
    return deny(
      `comando "${hit}" está em tools.deny_commands — use as ferramentas Read/Glob/Grep para ler/localizar arquivos em vez de shell`,
    );
  }
  return null;
}

/**
 * Extrai os caminhos que uma chamada de ferramenta pretende tocar,
 * para validação contra paths.allow/deny.
 */
export function pathsFromToolInput(toolName: string, input: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
    input.file_path,
    input.notebook_path,
    input.path,
    input.cwd,
  ];
  return candidates.filter((c): c is string => typeof c === 'string' && c.length > 0);
}

function resolveSafe(baseDir: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
  // Resolve symlinks do trecho existente do caminho para impedir escapes.
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const real = fs.realpathSync(probe);
    return path.join(real, path.relative(probe, abs));
  } catch {
    return abs;
  }
}

function isWithin(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Verifica se os caminhos tocados pela ferramenta respeitam paths.allow/deny.
 * Regras de caminho são relativas a baseDir (raiz do repositório). Deny vence.
 * Com allow vazio, qualquer caminho dentro de baseDir é aceito (menos os deny).
 */
export function checkPaths(
  config: AgentConfig,
  baseDir: string,
  touched: string[],
): Decision {
  // o próprio baseDir pode conter symlinks (ex. /tmp -> /private/tmp no macOS)
  baseDir = resolveSafe(baseDir, '.');
  const allowDirs = config.paths.allow.map((p) => resolveSafe(baseDir, p));
  const denyDirs = config.paths.deny.map((p) => resolveSafe(baseDir, p));

  for (const raw of touched) {
    const target = resolveSafe(baseDir, raw);
    for (const d of denyDirs) {
      if (isWithin(target, d) || target === d) {
        return deny(`caminho "${raw}" é negado por paths.deny ("${path.relative(baseDir, d) || d}")`);
      }
    }
    if (allowDirs.length > 0) {
      const ok = allowDirs.some((a) => isWithin(target, a) || target === a);
      if (!ok) {
        return deny(
          `caminho "${raw}" está fora dos diretórios permitidos (paths.allow: ${config.paths.allow.join(', ')})`,
        );
      }
    } else if (!isWithin(target, baseDir)) {
      return deny(`caminho "${raw}" está fora do projeto`);
    }
  }
  return allow('caminhos dentro das regras');
}

/**
 * Decisão completa para uma chamada de ferramenta.
 * Ordem: sempre-permitidas -> deny de tools -> allow de tools -> paths -> aprovação.
 */
export function checkToolUse(
  config: AgentConfig,
  baseDir: string,
  toolName: string,
  input: Record<string, unknown>,
  /** Se definido, restringe TODO acesso a este diretório (worktree da etapa). */
  scopeDir?: string,
): Decision {
  if (ALWAYS_ALLOWED_PREFIXES.some((p) => toolName.startsWith(p)) || ALWAYS_ALLOWED.has(toolName)) {
    return allow('ferramenta interna do runtime');
  }
  if (toolName === 'Task') {
    return deny('subagentes (Task) não são permitidos nesta plataforma');
  }

  const group = groupOfTool(toolName);
  const names = group ? [group, toolName] : [toolName];

  if (names.some((n) => config.tools.deny.includes(n))) {
    return deny(`ferramenta "${toolName}" (grupo "${group ?? '-'}") está em tools.deny`);
  }
  if (!names.some((n) => config.tools.allow.includes(n))) {
    return deny(
      `ferramenta "${toolName}" não está em tools.allow (permitidas: ${config.tools.allow.join(', ') || 'nenhuma'})`,
    );
  }

  // comandos de shell negados por nome (ex.: ls/cat/find): nega localmente,
  // antes de qualquer aprovação, evitando desperdício de rodadas do aprovador
  const cmdDecision = checkDeniedCommand(config, toolName, input);
  if (cmdDecision) return cmdDecision;

  const touched = pathsFromToolInput(toolName, input);
  if (touched.length > 0) {
    // Numa etapa com worktree, o acesso fica confinado à worktree: isso impede
    // que o agente escreva no workspace compartilhado (o que esvaziaria o merge).
    const effective = scopeDir
      ? { ...config, paths: { allow: [scopeDir], deny: config.paths.deny } }
      : config;
    const pathDecision = checkPaths(effective, baseDir, touched);
    if (!pathDecision.allowed) return pathDecision;
  }

  const approver =
    config.requires_approval_from[toolName] ??
    (group ? config.requires_approval_from[group] : undefined);
  if (approver) {
    return { allowed: true, reason: `exige aprovação de ${approver}`, needsApprovalFrom: approver };
  }

  return allow('permitida por tools.allow');
}

/** Um agente só conversa com quem can_talk_to permite (ou com o humano, sempre). */
export function checkCanTalkTo(config: AgentConfig, targetAgent: string): Decision {
  if (targetAgent === 'human') return allow('falar com o humano é sempre permitido');
  if (config.can_talk_to.includes(targetAgent)) return allow('permitido por can_talk_to');
  return deny(
    `agente "${config.name}" não pode falar com "${targetAgent}" (can_talk_to: ${config.can_talk_to.join(', ') || 'ninguém'})`,
  );
}

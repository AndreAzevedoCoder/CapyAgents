import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Raiz do repositório (onde ficam .env, agents/, pipelines/, assets/...). */
export const ROOT_DIR = path.resolve(here, '..', '..');

loadDotenv({ path: path.join(ROOT_DIR, '.env') });

export const PORT = Number(process.env.PORT || 4777);
export const HOST = '127.0.0.1'; // nunca exposto para fora da máquina

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';

/** Prazo para outro agente responder antes de escalar ao humano (padrão 5 min). */
export const BUS_TIMEOUT_MS = Number(process.env.BUS_TIMEOUT_MS || 300_000);

const budgetRaw = process.env.BUDGET_USD?.trim();
export const BUDGET_USD: number | null =
  budgetRaw && !Number.isNaN(Number(budgetRaw)) ? Number(budgetRaw) : null;

export const AGENTS_DIR = path.join(ROOT_DIR, 'agents');
export const PIPELINES_DIR = path.join(ROOT_DIR, 'pipelines');
export const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
export const CONFIG_DIR = path.join(ROOT_DIR, 'config');
export const WORKSPACE_DIR = path.join(ROOT_DIR, 'workspace');
export const DATA_DIR = path.join(ROOT_DIR, 'data');

for (const dir of [AGENTS_DIR, PIPELINES_DIR, WORKSPACE_DIR, DATA_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Ambiente mínimo repassado ao processo do agente.
 *
 * Autenticação, em ordem de preferência:
 * 1. Sem chave no .env (padrão): o CLI usa o login da sua assinatura
 *    (`claude login`), lido de ~/.claude — nada é copiado nem logado.
 * 2. ANTHROPIC_API_KEY definida no .env: usa a API diretamente.
 * A chave nunca é logada; só transita como variável de ambiente.
 */
export function agentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SHELL: process.env.SHELL,
    // Chamadas MCP do barramento podem bloquear por minutos (perguntas/aprovações).
    CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '3600000',
  };
  if (ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return env;
}

/** Descreve o modo de autenticação para o log de boot (sem vazar segredos). */
export function describeAuth(): string {
  if (ANTHROPIC_API_KEY) return 'autenticação: ANTHROPIC_API_KEY do .env';
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'autenticação: CLAUDE_CODE_OAUTH_TOKEN';
  const home = process.env.HOME ?? '';
  const hasCliCreds =
    home &&
    (fs.existsSync(path.join(home, '.claude', '.credentials.json')) ||
      fs.existsSync(path.join(home, '.claude.json')));
  if (hasCliCreds) {
    return 'autenticação: assinatura via Claude CLI (claude login)';
  }
  return (
    'autenticação: nenhuma credencial encontrada — rode `claude login` (assinatura) ' +
    'ou defina ANTHROPIC_API_KEY no .env; os agentes falharão até lá'
  );
}

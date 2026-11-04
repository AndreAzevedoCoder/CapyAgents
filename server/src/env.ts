import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Raiz da PLATAFORMA (código, web, assets 3D compartilhados). */
export const REPO_DIR = path.resolve(here, '..', '..');

/**
 * Raiz do PROJETO que está sendo executado. Por padrão é a própria plataforma
 * (a demo embutida); defina AGENT_OFFICE_PROJECT para rodar outro projeto, cujas
 * pastas agents/, pipelines/, config/, dados/, saida/ ficam sob essa raiz.
 */
export const PROJECT_DIR = process.env.AGENT_OFFICE_PROJECT
  ? path.resolve(process.env.AGENT_OFFICE_PROJECT)
  : REPO_DIR;

// .env do projeto tem prioridade; cai para o .env da plataforma (chave/login).
loadDotenv({ path: path.join(PROJECT_DIR, '.env') });
if (PROJECT_DIR !== REPO_DIR) loadDotenv({ path: path.join(REPO_DIR, '.env') });

export const PORT = Number(process.env.PORT || 4777);
export const HOST = '127.0.0.1'; // nunca exposto para fora da máquina

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';

/** Prazo para outro agente responder antes de escalar ao humano (padrão 5 min). */
export const BUS_TIMEOUT_MS = Number(process.env.BUS_TIMEOUT_MS || 300_000);

const budgetRaw = process.env.BUDGET_USD?.trim();
export const BUDGET_USD: number | null =
  budgetRaw && !Number.isNaN(Number(budgetRaw)) ? Number(budgetRaw) : null;

/**
 * Base para resolver permissões e caminhos do agent.json. É a raiz do projeto:
 * paths.allow/deny como "./dados" são relativos a ela.
 */
export const ROOT_DIR = PROJECT_DIR;

export const AGENTS_DIR = path.join(PROJECT_DIR, 'agents');
export const PIPELINES_DIR = path.join(PROJECT_DIR, 'pipelines');
export const CONFIG_DIR = path.join(PROJECT_DIR, 'config');
export const DATA_DIR = path.join(PROJECT_DIR, 'data');
export const WORKSPACE_DIR = path.join(PROJECT_DIR, 'workspace');
// assets 3D são da plataforma, compartilhados entre projetos
export const ASSETS_DIR = path.join(REPO_DIR, 'assets');

/**
 * Diretório de trabalho padrão dos agentes (turnos sem worktree). Configurável
 * por config/project.json: { "work_dir": "." } para projetos que escrevem na
 * própria raiz, ou "workspace" (padrão) para projetos com git/worktrees.
 */
function readWorkDir(): string {
  const file = path.join(CONFIG_DIR, 'project.json');
  if (fs.existsSync(file)) {
    try {
      const wd = JSON.parse(fs.readFileSync(file, 'utf8')).work_dir;
      if (typeof wd === 'string' && wd.trim()) {
        return path.resolve(PROJECT_DIR, wd);
      }
    } catch {
      /* usa o padrão */
    }
  }
  return WORKSPACE_DIR;
}
export const WORK_DIR = readWorkDir();

for (const dir of [AGENTS_DIR, PIPELINES_DIR, DATA_DIR, WORK_DIR, WORKSPACE_DIR]) {
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

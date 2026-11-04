import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, WORKSPACE_DIR } from '../env.js';

/**
 * Worktrees git para execução paralela: cada instância trabalha em uma
 * worktree/branch própria; o merge é uma etapa explícita da pipeline.
 */

function git(args: string[], cwd: string = WORKSPACE_DIR): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Fila de operações git do runtime (criar worktree, commit, merge). Serializa
 * esses comandos entre si para não colidirem no index.lock do repositório —
 * inclusive quando um agente também está rodando git pelo Bash em paralelo.
 * O trabalho dos agentes continua paralelo; só o git do servidor entra na fila.
 */
let gitQueue: Promise<unknown> = Promise.resolve();
export function withGitLock<T>(fn: () => T): Promise<T> {
  const run = gitQueue.then(fn);
  gitQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Garante que workspace/ é um repositório git com um commit inicial. */
export function ensureWorkspaceRepo(): void {
  if (!fs.existsSync(path.join(WORKSPACE_DIR, '.git'))) {
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'agents@local']);
    git(['config', 'user.name', 'Agent Office']);
    fs.writeFileSync(
      path.join(WORKSPACE_DIR, 'README.md'),
      '# Workspace\n\nÁrea de trabalho dos agentes.\n',
    );
    git(['add', '-A']);
    git(['commit', '-m', 'init workspace']);
  }
}

export interface Worktree {
  branch: string;
  dir: string;
}

/**
 * Cria (ou reaproveita) a worktree de uma etapa/instância.
 * Idempotente: em um retry, a worktree/branch já pode existir — nesse caso
 * reaproveita em vez de falhar.
 */
export function createWorktree(runId: string, stepId: string): Worktree {
  ensureWorkspaceRepo();
  const branch = `${runId}-${stepId}`;
  const dir = path.join(DATA_DIR, 'worktrees', branch);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  // já registrada e presente? reaproveita.
  const existing = git(['worktree', 'list', '--porcelain']);
  if (existing.includes(dir) && fs.existsSync(dir)) {
    return { branch, dir };
  }
  // diretório sobrou de uma tentativa anterior sem registro válido: limpa.
  if (fs.existsSync(dir)) {
    try {
      git(['worktree', 'remove', '--force', dir]);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const branchExists = git(['branch', '--list', branch]).trim() !== '';
  const args = branchExists
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, 'main'];
  git(args);
  return { branch, dir };
}

/** Commita tudo que a etapa produziu na worktree (ponto seguro antes do merge). */
export function commitAll(wt: Worktree, message: string): void {
  git(['add', '-A'], wt.dir);
  const status = git(['status', '--porcelain'], wt.dir);
  if (status.trim()) {
    git(['commit', '-m', message], wt.dir);
  }
}

/**
 * Faz merge das branches na main do workspace. Lança erro com detalhe em
 * caso de conflito (o merge é abortado para manter a main limpa).
 */
export function mergeBranches(branches: string[], message: string): string {
  ensureWorkspaceRepo();
  const merged: string[] = [];
  for (const branch of branches) {
    try {
      git(['merge', '--no-ff', '-m', `${message} (${branch})`, branch]);
      merged.push(branch);
    } catch (err) {
      try {
        git(['merge', '--abort']);
      } catch {
        /* nada para abortar */
      }
      throw new Error(
        `conflito ao fazer merge de "${branch}" (já integrados: ${merged.join(', ') || 'nenhum'}): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
  return git(['log', '--oneline', '-n', String(branches.length + 1)]);
}

/** Remove a worktree (mantém a branch para histórico). */
export function removeWorktree(wt: Worktree): void {
  try {
    git(['worktree', 'remove', '--force', wt.dir]);
  } catch {
    /* já removida */
  }
}

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { AgentConfig } from '@agent-office/shared';
import {
  checkCanTalkTo,
  checkPaths,
  checkToolUse,
  commandNames,
  expandToolGroups,
  groupOfTool,
} from '../src/permissions/engine.js';

const BASE = path.resolve('/tmp/office-base');

function cfg(partial: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'dev',
    model: 'claude-sonnet-5',
    instances: 1,
    hat: 'cowboy',
    tools: { allow: ['read', 'edit', 'bash'], deny: ['web'], deny_commands: [] },
    paths: { allow: ['./workspace'], deny: ['./.env'] },
    can_talk_to: ['reviewer', 'planner'],
    requires_approval_from: { bash: 'reviewer' },
    max_turns: 80,
    ...partial,
  };
}

describe('grupos de ferramentas', () => {
  it('mapeia ferramentas do SDK para grupos amigáveis', () => {
    expect(groupOfTool('Read')).toBe('read');
    expect(groupOfTool('Write')).toBe('edit');
    expect(groupOfTool('Bash')).toBe('bash');
    expect(groupOfTool('WebSearch')).toBe('web');
    expect(groupOfTool('Desconhecida')).toBeNull();
  });

  it('expande grupos em ferramentas', () => {
    expect(expandToolGroups(['read'])).toContain('Grep');
    expect(expandToolGroups(['NomeExato'])).toEqual(['NomeExato']);
  });

  it('commandNames extrai comandos de pipes e encadeamentos', () => {
    expect(commandNames('ls -la')).toEqual(['ls']);
    expect(commandNames('cat x | grep y')).toEqual(['cat', 'grep']);
    expect(commandNames('mkdir a && cd a')).toEqual(['mkdir', 'cd']);
    expect(commandNames('FOO=1 node x.js')).toEqual(['node']);
    expect(commandNames('/bin/ls')).toEqual(['ls']);
  });
});

describe('checkToolUse', () => {
  it('permite ferramenta do grupo allow', () => {
    const d = checkToolUse(cfg(), BASE, 'Read', { file_path: './workspace/a.ts' });
    expect(d.allowed).toBe(true);
    expect(d.needsApprovalFrom).toBeUndefined();
  });

  it('nega ferramenta em deny mesmo que também esteja em allow', () => {
    const d = checkToolUse(
      cfg({ tools: { allow: ['web'], deny: ['web'] } }),
      BASE,
      'WebSearch',
      {},
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('tools.deny');
  });

  it('nega ferramenta fora do allow', () => {
    const d = checkToolUse(
      cfg({ tools: { allow: ['read'], deny: [] } }),
      BASE,
      'WebFetch',
      { url: 'https://x' },
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('não está em tools.allow');
  });

  it('nega subagentes (Task) sempre', () => {
    const d = checkToolUse(cfg({ tools: { allow: ['Task'], deny: [] } }), BASE, 'Task', {});
    expect(d.allowed).toBe(false);
  });

  it('sempre permite as ferramentas do barramento', () => {
    const d = checkToolUse(cfg({ tools: { allow: [], deny: [] } }), BASE, 'mcp__bus__send_message', {});
    expect(d.allowed).toBe(true);
  });

  it('exige aprovação quando o grupo está em requires_approval_from', () => {
    const d = checkToolUse(cfg(), BASE, 'Bash', { command: 'node todo.test.js' });
    expect(d.allowed).toBe(true);
    expect(d.needsApprovalFrom).toBe('reviewer');
  });

  it('nega comando de deny_commands localmente, sem exigir aprovação', () => {
    const c = cfg({
      tools: { allow: ['bash'], deny: [], deny_commands: ['ls', 'cat', 'find'] },
    });
    const d = checkToolUse(c, BASE, 'Bash', { command: 'ls -la /tmp' });
    expect(d.allowed).toBe(false);
    expect(d.needsApprovalFrom).toBeUndefined();
    expect(d.reason).toContain('deny_commands');
  });

  it('pega comando negado dentro de um pipe', () => {
    const c = cfg({
      tools: { allow: ['bash'], deny: [], deny_commands: ['grep'] },
    });
    const d = checkToolUse(c, BASE, 'Bash', { command: 'node x.js | grep erro' });
    expect(d.allowed).toBe(false);
  });

  it('não bloqueia comando permitido mesmo com deny_commands definido', () => {
    const c = cfg({
      tools: { allow: ['bash'], deny: [], deny_commands: ['ls', 'cat'] },
    });
    const d = checkToolUse(c, BASE, 'Bash', { command: 'node todo.test.js' });
    expect(d.allowed).toBe(true);
  });

  it('bloqueia caminho em paths.deny (o caso .env)', () => {
    const d = checkToolUse(cfg(), BASE, 'Read', { file_path: './.env' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('paths.deny');
  });

  it('bloqueia caminho fora de paths.allow', () => {
    const d = checkToolUse(cfg(), BASE, 'Write', {
      file_path: path.join(BASE, 'config/models.json'),
      content: 'x',
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('fora dos diretórios permitidos');
  });

  it('bloqueia escape por ..', () => {
    const d = checkToolUse(cfg(), BASE, 'Read', {
      file_path: './workspace/../.env',
    });
    expect(d.allowed).toBe(false);
  });

  it('scopeDir (worktree) confina o acesso, bloqueando o workspace compartilhado', () => {
    const scope = path.join(BASE, 'data/worktrees/run_x-dev_a');
    // escrita dentro da worktree: permitida
    const ok = checkToolUse(cfg(), BASE, 'Write', { file_path: path.join(scope, 'todo.js'), content: 'x' }, scope);
    expect(ok.allowed).toBe(true);
    // escrita no workspace compartilhado (normalmente permitido) fica bloqueada
    const no = checkToolUse(cfg(), BASE, 'Write', { file_path: path.join(BASE, 'workspace/todo.js'), content: 'x' }, scope);
    expect(no.allowed).toBe(false);
  });
});

describe('checkPaths', () => {
  it('com allow vazio, aceita dentro do projeto e nega fora', () => {
    const c = cfg({ paths: { allow: [], deny: [] } });
    expect(checkPaths(c, BASE, [path.join(BASE, 'qualquer/coisa.ts')]).allowed).toBe(true);
    expect(checkPaths(c, BASE, ['/etc/passwd']).allowed).toBe(false);
  });

  it('deny vence allow', () => {
    const c = cfg({ paths: { allow: ['./workspace'], deny: ['./workspace/secrets'] } });
    expect(checkPaths(c, BASE, [path.join(BASE, 'workspace/ok.ts')]).allowed).toBe(true);
    expect(checkPaths(c, BASE, [path.join(BASE, 'workspace/secrets/k.pem')]).allowed).toBe(false);
  });
});

describe('checkCanTalkTo', () => {
  it('permite alvos de can_talk_to e o humano', () => {
    expect(checkCanTalkTo(cfg(), 'reviewer').allowed).toBe(true);
    expect(checkCanTalkTo(cfg(), 'human').allowed).toBe(true);
  });

  it('nega quem não está na lista, com motivo claro', () => {
    const d = checkCanTalkTo(cfg(), 'intruso');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('can_talk_to');
  });
});

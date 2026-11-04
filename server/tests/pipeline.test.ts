import { describe, expect, it } from 'vitest';
import type { PipelineDef } from '@capyagents/shared';
import { parsePipeline } from '../src/pipelines/parser.js';
import { PipelineExecutor } from '../src/pipelines/executor.js';
import { MessageBus } from '../src/bus/bus.js';
import { Hub } from '../src/hub.js';
import { openDb } from '../src/db/database.js';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('parser de pipelines', () => {
  it('aceita uma pipeline válida com paralelismo', () => {
    const def = parsePipeline(
      'x.yaml',
      `
name: demo
description: teste
steps:
  - id: plan
    agent: planner
    task: planeje
  - id: a
    agent: dev-1
    task: "parte 1: {{steps.plan.output}}"
    depends_on: [plan]
    worktree: true
  - id: b
    agent: dev-2
    task: parte 2
    depends_on: [plan]
    worktree: true
  - id: merge
    agent: reviewer
    task: integre
    depends_on: [a, b]
    merge: true
    human_approval: true
`,
    );
    expect(def.steps).toHaveLength(4);
    expect(def.steps[3].human_approval).toBe(true);
  });

  it('rejeita dependência inexistente', () => {
    expect(() =>
      parsePipeline(
        'x.yaml',
        `
name: demo
steps:
  - id: a
    agent: dev
    task: t
    depends_on: [fantasma]
`,
      ),
    ).toThrow(/fantasma/);
  });

  it('rejeita ciclo de dependências', () => {
    expect(() =>
      parsePipeline(
        'x.yaml',
        `
name: demo
steps:
  - id: a
    agent: dev
    task: t
    depends_on: [b]
  - id: b
    agent: dev
    task: t
    depends_on: [a]
`,
      ),
    ).toThrow(/ciclo/);
  });
});

// ---------------------------------------------------------------------------
// Executor (manager e instâncias falsas; sem SDK)
// ---------------------------------------------------------------------------

interface FakeInstance {
  id: string;
  agentName: string;
  state: string;
  isStopped: boolean;
  calls: Array<{ prompt: string; opts: any }>;
  request: (prompt: string, label: string, opts?: any) => Promise<string>;
}

function fakeInstance(
  id: string,
  agentName: string,
  impl?: (prompt: string) => Promise<string> | string,
): FakeInstance {
  const inst: FakeInstance = {
    id,
    agentName,
    state: 'idle',
    isStopped: false,
    calls: [],
    async request(prompt, _label, opts) {
      inst.calls.push({ prompt, opts });
      inst.state = 'working';
      try {
        const out = impl ? await impl(prompt) : `saída de ${id}`;
        return out;
      } finally {
        inst.state = 'idle';
      }
    },
  };
  return inst;
}

function makeExecutor(defs: PipelineDef[], instances: FakeInstance[], dbExistente?: any) {
  const db = dbExistente ?? openDb(':memory:');
  const hub = new Hub();
  const bus = new MessageBus(5_000);
  const manager = {
    bus,
    instances: new Map(instances.map((i) => [i.id, i])),
  } as any;
  const executor = new PipelineExecutor(
    db,
    hub,
    manager,
    new Map(defs.map((d) => [d.name, d])),
  );
  return { executor, bus, db };
}

async function waitStatus(
  executor: PipelineExecutor,
  runId: string,
  statuses: string[],
  timeoutMs = 5000,
): Promise<any> {
  const start = Date.now();
  for (;;) {
    const run = executor.allRuns().find((r) => r.id === runId);
    if (run && statuses.includes(run.status)) return run;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout esperando ${statuses}; atual: ${run?.status}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const noWorktree = { worktree: false, merge: false, human_approval: false };

function step(partial: any) {
  return {
    depends_on: [],
    inputs: [],
    outputs: [],
    done_when: null,
    retries: 0,
    ...noWorktree,
    ...partial,
  };
}

describe('executor de pipelines', () => {
  it('executa o grafo com paralelismo e interpolação de saídas', async () => {
    const def: PipelineDef = {
      name: 'p',
      description: '',
      steps: [
        step({ id: 'plan', agent: 'planner', task: 'planeje' }),
        step({ id: 'a', agent: 'dev', task: 'faça A com: {{steps.plan.output}}', depends_on: ['plan'] }),
        step({ id: 'b', agent: 'dev', task: 'faça B', depends_on: ['plan'] }),
        step({ id: 'fim', agent: 'reviewer', task: 'revise', depends_on: ['a', 'b'] }),
      ],
    };
    const planner = fakeInstance('planner-1', 'planner', () => 'O PLANO');
    let concurrent = 0;
    let maxConcurrent = 0;
    const devImpl = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
      return 'feito';
    };
    const dev1 = fakeInstance('dev-1', 'dev', devImpl);
    const dev2 = fakeInstance('dev-2', 'dev', devImpl);
    const reviewer = fakeInstance('reviewer-1', 'reviewer');
    const { executor } = makeExecutor([def], [planner, dev1, dev2, reviewer]);

    const run = executor.start('p');
    const finished = await waitStatus(executor, run.id, ['done', 'failed']);

    expect(finished.status).toBe('done');
    // as duas etapas paralelas usaram instâncias diferentes, ao mesmo tempo
    expect(dev1.calls).toHaveLength(1);
    expect(dev2.calls).toHaveLength(1);
    expect(maxConcurrent).toBe(2);
    // interpolação da saída do plan
    const promptA = [...dev1.calls, ...dev2.calls].find((c) => c.prompt.includes('faça A'));
    expect(promptA!.prompt).toContain('O PLANO');
    // contexto de dependências chega à revisão
    expect(reviewer.calls[0].prompt).toContain('Saída da etapa');
  });

  it('aprovação humana: aparece como pendência e aprovar libera a etapa', async () => {
    const def: PipelineDef = {
      name: 'p',
      description: '',
      steps: [step({ id: 'a', agent: 'dev', task: 'faça', human_approval: true })],
    };
    const dev = fakeInstance('dev-1', 'dev');
    const { executor, bus } = makeExecutor([def], [dev]);
    const run = executor.start('p');

    await new Promise((r) => setTimeout(r, 50));
    const pending = bus.pendingFor('human');
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toContain('aprovar a etapa');
    bus.respond(pending[0].id, 'human', { approved: true, text: 'vai' });

    const finished = await waitStatus(executor, run.id, ['done', 'failed']);
    expect(finished.status).toBe('done');
    expect(dev.calls).toHaveLength(1);
  });

  it('aprovação humana negada falha a etapa e a execução', async () => {
    const def: PipelineDef = {
      name: 'p',
      description: '',
      steps: [step({ id: 'a', agent: 'dev', task: 'faça', human_approval: true })],
    };
    const dev = fakeInstance('dev-1', 'dev');
    const { executor, bus } = makeExecutor([def], [dev]);
    const run = executor.start('p');

    await new Promise((r) => setTimeout(r, 50));
    const pending = bus.pendingFor('human');
    bus.respond(pending[0].id, 'human', { approved: false, text: 'não' });

    const finished = await waitStatus(executor, run.id, ['done', 'failed']);
    expect(finished.status).toBe('failed');
    expect(dev.calls).toHaveLength(0);
  });

  it('retry: falha uma vez e conclui na segunda tentativa', async () => {
    let attempt = 0;
    const def: PipelineDef = {
      name: 'p',
      description: '',
      steps: [step({ id: 'a', agent: 'dev', task: 'instável', retries: 1 })],
    };
    const dev = fakeInstance('dev-1', 'dev', async () => {
      attempt++;
      if (attempt === 1) throw new Error('falhou de propósito');
      return 'ok';
    });
    const { executor } = makeExecutor([def], [dev]);
    const run = executor.start('p');
    const finished = await waitStatus(executor, run.id, ['done', 'failed']);
    expect(finished.status).toBe('done');
    expect(finished.steps[0].attempts).toBe(2);
  });

  it('reinício retoma sozinho o que estava rodando, preservando o que já terminou', async () => {
    const def: PipelineDef = {
      name: 'p',
      description: '',
      steps: [
        step({ id: 'a', agent: 'dev', task: 'primeira' }),
        step({ id: 'b', agent: 'dev', task: 'segunda', depends_on: ['a'] }),
      ],
    };
    // trava a etapa b para o "reinício" acontecer com ela no ar
    let segurar = true;
    const dev = fakeInstance('dev-1', 'dev', async (prompt) => {
      if (prompt.includes('segunda')) {
        while (segurar) await new Promise((r) => setTimeout(r, 10));
      }
      return 'ok';
    });
    const primeiro = makeExecutor([def], [dev]);
    const run = primeiro.executor.start('p');
    // espera a etapa b estar rodando
    for (let i = 0; i < 200; i++) {
      const r = primeiro.executor.allRuns().find((x) => x.id === run.id)!;
      if (r.steps.find((s) => s.stepId === 'b')?.status === 'running') break;
      await new Promise((r2) => setTimeout(r2, 20));
    }

    // "reinicia": executor novo sobre o MESMO banco
    segurar = false;
    const dev2 = fakeInstance('dev-1', 'dev');
    const segundo = makeExecutor([def], [dev2], primeiro.db);
    segundo.executor.restore();

    const depois = segundo.executor.allRuns().find((x) => x.id === run.id)!;
    // a etapa concluída continua concluída — não é refeita
    expect(depois.steps.find((s) => s.stepId === 'a')!.status).toBe('done');
    // e a execução volta a andar sozinha, sem precisar de "retomar"
    expect(depois.status).toBe('running');
    const fim = await waitStatus(segundo.executor, run.id, ['done', 'failed']);
    expect(fim.status).toBe('done');
    expect(dev2.calls.some((c) => c.prompt.includes('primeira'))).toBe(false);
  });
});

import type {
  PipelineDef,
  PipelineRun,
  PipelineStepDef,
  StepRun,
} from '@capyagents/shared';
import { HUMAN } from '@capyagents/shared';
import type { Db } from '../db/database.js';
import { loadPipelineRuns, savePipelineRun } from '../db/database.js';
import type { Hub } from '../hub.js';
import type { RuntimeManager } from '../runtime/manager.js';
import type { AgentInstance } from '../runtime/instance.js';
import { newId } from '../ids.js';
import {
  commitAll,
  createWorktree,
  mergeBranches,
  withGitLock,
  type Worktree,
} from './worktrees.js';

interface RunCtx {
  run: PipelineRun;
  def: PipelineDef;
  paused: boolean;
  cancelled: boolean;
  worktrees: Map<string, Worktree>;
  /** instâncias ocupadas por etapas em andamento desta execução. */
  busy: Set<string>;
}

/**
 * Executor de pipelines: grafo de etapas com dependências, paralelismo,
 * aprovação humana, retry e merge explícito de worktrees.
 */
export class PipelineExecutor {
  readonly defs: Map<string, PipelineDef>;
  private runs = new Map<string, RunCtx>();

  constructor(
    private db: Db,
    private hub: Hub,
    private manager: RuntimeManager,
    defs: Map<string, PipelineDef>,
  ) {
    this.defs = defs;
  }

  /** Execuções conhecidas (vivas + histórico do banco). */
  allRuns(): PipelineRun[] {
    const live = new Map([...this.runs.values()].map((c) => [c.run.id, c.run]));
    const stored = loadPipelineRuns(this.db).filter((r) => !live.has(r.id));
    return [...stored, ...live.values()];
  }

  /**
   * Retoma o que ficou pelo caminho num reinício.
   *
   * Etapas concluídas continuam concluídas; só a que estava no ar volta para
   * a fila, e o agente a refaz com a sessão dele restaurada, ou seja,
   * lembrando do que já tinha feito e com os arquivos ainda em disco.
   *
   * Quem estava rodando volta a rodar sozinho. Só continua pausado o que VOCÊ
   * pausou — reiniciar o servidor não é uma decisão de parar o trabalho.
   */
  restore(): void {
    for (const run of loadPipelineRuns(this.db)) {
      if (run.status !== 'running' && run.status !== 'paused') continue;
      const def = this.defs.get(run.pipeline);
      if (!def) continue;
      const pausadaPeloUsuario = run.status === 'paused';
      // o turno em voo se perdeu com o processo: a etapa volta para a fila
      for (const s of run.steps) {
        if (s.status === 'running' || s.status === 'waiting_approval') s.status = 'pending';
      }
      const ctx: RunCtx = {
        run,
        def,
        paused: pausadaPeloUsuario,
        cancelled: false,
        worktrees: new Map(),
        busy: new Set(),
      };
      this.runs.set(run.id, ctx);
      this.persist(ctx);
      if (!pausadaPeloUsuario) void this.tick(ctx);
    }
  }

  start(pipelineName: string): PipelineRun {
    const def = this.defs.get(pipelineName);
    if (!def) throw new Error(`pipeline "${pipelineName}" não existe`);
    const run: PipelineRun = {
      id: newId('run'),
      pipeline: def.name,
      status: 'running',
      steps: def.steps.map(
        (s): StepRun => ({
          stepId: s.id,
          status: 'pending',
          instanceId: null,
          attempts: 0,
          output: null,
          artifacts: [],
          startedAt: null,
          endedAt: null,
          error: null,
        }),
      ),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      startedAt: Date.now(),
      endedAt: null,
    };
    const ctx: RunCtx = {
      run,
      def,
      paused: false,
      cancelled: false,
      worktrees: new Map(),
      busy: new Set(),
    };
    this.runs.set(run.id, ctx);
    this.persist(ctx);
    void this.tick(ctx);
    return run;
  }

  control(runId: string, action: 'pause' | 'resume' | 'cancel'): void {
    const ctx = this.runs.get(runId);
    if (!ctx) throw new Error(`execução ${runId} não encontrada`);
    if (action === 'pause') {
      ctx.paused = true;
      if (ctx.run.status === 'running') ctx.run.status = 'paused';
    } else if (action === 'resume') {
      ctx.paused = false;
      if (ctx.run.status === 'paused') ctx.run.status = 'running';
      void this.tick(ctx);
    } else {
      ctx.cancelled = true;
      ctx.run.status = 'cancelled';
      ctx.run.endedAt = Date.now();
    }
    this.persist(ctx);
  }

  // -------------------------------------------------------------------------

  private persist(ctx: RunCtx): void {
    savePipelineRun(this.db, ctx.run);
    this.hub.broadcast({ type: 'pipeline_update', run: { ...ctx.run, steps: [...ctx.run.steps] } });
  }

  private stepRun(ctx: RunCtx, stepId: string): StepRun {
    return ctx.run.steps.find((s) => s.stepId === stepId)!;
  }

  private async tick(ctx: RunCtx): Promise<void> {
    if (ctx.paused || ctx.cancelled) return;

    const done = new Set(ctx.run.steps.filter((s) => s.status === 'done').map((s) => s.stepId));
    const failed = ctx.run.steps.some((s) => s.status === 'failed');
    if (failed) {
      ctx.run.status = 'failed';
      ctx.run.endedAt = Date.now();
      this.persist(ctx);
      return;
    }
    if (done.size === ctx.run.steps.length) {
      ctx.run.status = 'done';
      ctx.run.endedAt = Date.now();
      this.persist(ctx);
      this.hub.broadcast({
        type: 'toast',
        level: 'info',
        text: `Pipeline "${ctx.def.name}" concluída.`,
      });
      return;
    }

    const ready = ctx.def.steps.filter((stepDef) => {
      const sr = this.stepRun(ctx, stepDef.id);
      return sr.status === 'pending' && stepDef.depends_on.every((d) => done.has(d));
    });

    for (const stepDef of ready) {
      // marca já como running para o próximo tick não re-agendar
      const sr = this.stepRun(ctx, stepDef.id);
      sr.status = stepDef.human_approval ? 'waiting_approval' : 'running';
      this.persist(ctx);
      void this.runStep(ctx, stepDef).catch(() => undefined);
    }
  }

  private async runStep(ctx: RunCtx, stepDef: PipelineStepDef): Promise<void> {
    const sr = this.stepRun(ctx, stepDef.id);
    sr.startedAt = Date.now();

    try {
      if (stepDef.human_approval) {
        const reply = await this.manager.bus.requestPermission(
          `pipeline:${ctx.run.id}`,
          HUMAN,
          `Pipeline "${ctx.def.name}": aprovar a etapa "${stepDef.id}" (${stepDef.task.slice(0, 200)})?`,
          null,
          null,
        );
        if (!reply.approved) {
          sr.status = 'failed';
          sr.error = `aprovação humana negada: ${reply.content}`;
          sr.endedAt = Date.now();
          this.persist(ctx);
          void this.tick(ctx);
          return;
        }
        sr.status = 'running';
        this.persist(ctx);
      }

      if (ctx.cancelled) return;

      // Merge explícito: integra as worktrees das dependências na main.
      let mergeReport = '';
      if (stepDef.merge) {
        // nomes de branch são determinísticos (runId-stepId), então o merge
        // funciona mesmo depois de um reinício do servidor
        const branches = stepDef.depends_on
          .filter((d) => ctx.def.steps.find((s) => s.id === d)?.worktree)
          .map((d) => `${ctx.run.id}-${d}`);
        if (branches.length) {
          mergeReport = await withGitLock(() =>
            mergeBranches(branches, `pipeline ${ctx.def.name} / ${stepDef.id}`),
          );
          sr.artifacts.push(`merge: ${branches.join(', ')}`);
        }
      }

      const instance = await this.acquireInstance(ctx, stepDef.agent);
      sr.instanceId = instance.id;
      this.persist(ctx);

      let workdir: string | undefined;
      if (stepDef.worktree) {
        const wt = await withGitLock(() => createWorktree(ctx.run.id, stepDef.id));
        ctx.worktrees.set(stepDef.id, wt);
        workdir = wt.dir;
        sr.artifacts.push(`worktree: ${wt.branch}`);
        instance.log('system', `Worktree da etapa "${stepDef.id}": ${wt.dir}`);
      }

      const prompt = this.buildPrompt(ctx, stepDef, mergeReport);
      sr.attempts++;
      this.persist(ctx);

      try {
        const output = await instance.request(prompt, `Pipeline ${ctx.def.name}: ${stepDef.id}`, {
          runId: ctx.run.id,
          workdir,
        });
        if (stepDef.worktree) {
          await withGitLock(() =>
            commitAll(ctx.worktrees.get(stepDef.id)!, `pipeline ${ctx.def.name}: ${stepDef.id}`),
          );
        }
        sr.output = output || '(sem saída)';
        sr.status = 'done';
        sr.endedAt = Date.now();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (sr.attempts <= stepDef.retries && !ctx.cancelled && !ctx.paused) {
          sr.error = `tentativa ${sr.attempts} falhou (${msg}); tentando de novo`;
          sr.status = 'pending';
        } else {
          sr.status = 'failed';
          sr.error = msg;
          sr.endedAt = Date.now();
        }
      } finally {
        ctx.busy.delete(instance.id);
      }
    } catch (err) {
      sr.status = 'failed';
      sr.error = err instanceof Error ? err.message : String(err);
      sr.endedAt = Date.now();
    }

    this.persist(ctx);
    void this.tick(ctx);
  }

  /** Espera por uma instância livre do tipo pedido (ou a instância exata). */
  private async acquireInstance(ctx: RunCtx, agent: string): Promise<AgentInstance> {
    for (let i = 0; i < 600; i++) {
      const exact = this.manager.instances.get(agent);
      const candidates = exact
        ? [exact]
        : [...this.manager.instances.values()].filter(
            (inst) => inst.agentName === agent && !inst.isStopped,
          );
      if (candidates.length === 0 && !exact) {
        throw new Error(`nenhuma instância do agente "${agent}" disponível`);
      }
      const free = candidates.find((inst) => !ctx.busy.has(inst.id) && inst.state === 'idle');
      const fallback = candidates.find((inst) => !ctx.busy.has(inst.id));
      const chosen = free ?? (i > 30 ? fallback : undefined);
      if (chosen) {
        ctx.busy.add(chosen.id);
        return chosen;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`tempo esgotado aguardando instância de "${agent}"`);
  }

  private buildPrompt(ctx: RunCtx, stepDef: PipelineStepDef, mergeReport: string): string {
    let task = stepDef.task;
    for (const dep of stepDef.depends_on) {
      const out = this.stepRun(ctx, dep).output ?? '';
      task = task.replaceAll(`{{steps.${dep}.output}}`, out);
    }
    const parts = [
      `Você está executando a etapa "${stepDef.id}" da pipeline "${ctx.def.name}".`,
      '',
      task,
    ];
    const depOutputs = stepDef.depends_on
      .filter((d) => !stepDef.task.includes(`{{steps.${d}.output}}`))
      .map((d) => `### Saída da etapa "${d}"\n${this.stepRun(ctx, d).output ?? '(vazia)'}`);
    if (depOutputs.length) {
      parts.push('', '## Contexto das etapas anteriores', ...depOutputs);
    }
    if (mergeReport) {
      parts.push('', `## Merge já realizado pelo sistema\n\`\`\`\n${mergeReport}\n\`\`\``);
    }
    if (stepDef.outputs.length) {
      parts.push('', `Entregas esperadas: ${stepDef.outputs.join(', ')}.`);
    }
    if (stepDef.done_when) {
      parts.push('', `Critério de conclusão: ${stepDef.done_when}`);
    }
    return parts.join('\n');
  }
}

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentDefinition, InstanceInfo, ModelInfo } from '@capyagents/shared';
import { HUMAN } from '@capyagents/shared';
import type { Db } from '../db/database.js';
import { deleteInstance, loadInstances, saveMessage } from '../db/database.js';
import { MessageBus } from '../bus/bus.js';
import type { Hub } from '../hub.js';
import { CostTracker } from '../cost/cost.js';
import { checkCanTalkTo } from '../permissions/engine.js';
import { AgentInstance } from './instance.js';
import { makeFileServer } from './files.js';

/**
 * Gerencia o ciclo de vida das instâncias de agentes, o barramento e o custo.
 */
export interface MeetingStarter {
  start(opts: {
    title: string;
    agenda: string;
    participants: string[];
    startedBy: string;
    maxRounds?: number;
  }): { id: string };
}

export class RuntimeManager {
  readonly instances = new Map<string, AgentInstance>();
  readonly bus: MessageBus;
  /** Ligado depois da construção (dependência circular com MeetingService). */
  meetings: MeetingStarter | null = null;

  constructor(
    private db: Db,
    private hub: Hub,
    public defs: Map<string, AgentDefinition>,
    private models: ModelInfo[],
    readonly cost: CostTracker,
    busTimeoutMs = 120_000,
  ) {
    this.bus = new MessageBus(busTimeoutMs);

    this.bus.on('message', (m) => {
      saveMessage(this.db, m);
      this.hub.broadcast({ type: 'bus_message', message: m });
      // registra nos logs dos envolvidos para o painel
      for (const party of [m.from, m.to]) {
        const inst = this.instances.get(party);
        if (inst) {
          inst.log('message', `[${m.type}] ${m.from} -> ${m.to}: ${m.content.slice(0, 500)}`);
        }
      }
    });

    this.bus.on('deliver', (m) => {
      if (m.to === HUMAN) return;
      const target = this.instances.get(m.to);
      if (!target) return;
      let prompt: string;
      let label: string;
      if (m.type === 'question') {
        prompt = `Pergunta de ${m.from} (request_id: "${m.id}"):\n\n${m.content}\n\nResponda usando a ferramenta respond do servidor bus, passando request_id="${m.id}" e o campo text com a resposta. Depois retome o que estava fazendo.`;
        label = `Respondendo pergunta de ${m.from}`;
      } else if (m.type === 'permission_request') {
        prompt = `Pedido de permissão de ${m.from} (request_id: "${m.id}"):\n\n${m.content}\n\nAvalie com cuidado. Responda usando a ferramenta respond do servidor bus com request_id="${m.id}", approve=true ou false e uma justificativa curta em text.`;
        label = `Avaliando pedido de ${m.from}`;
      } else {
        prompt = `Mensagem de ${m.from}:\n\n${m.content}\n\n(Não é obrigatório responder; use send_message se precisar.)`;
        label = `Mensagem de ${m.from}`;
      }
      target.enqueue(prompt, label);
    });

    this.bus.on('escalated', (m, reason) => {
      this.hub.broadcast({
        type: 'toast',
        level: 'warn',
        text: `Pedido de ${m.from} escalado para você: ${reason}`,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  /** Restaura instâncias do SQLite (histórico sobrevive a reinício). */
  restore(): void {
    for (const row of loadInstances(this.db)) {
      const def = this.defs.get(row.agent);
      if (!def) continue; // agente removido do disco
      const inst = this.makeInstance(row.id, def, row.desk_index, row.workdir ?? undefined);
      inst.sessionId = row.session_id;
      inst.hat = row.hat || def.config.hat;
      // estados transitórios não sobrevivem ao reinício
      inst.state = row.state === 'done' || row.state === 'error' ? (row.state as any) : 'idle';
      inst.task = row.task;
      this.instances.set(inst.id, inst);
      inst.persist();
    }
  }

  /** Cria as instâncias padrão declaradas em agent.json (primeira execução). */
  ensureDefaultInstances(): void {
    for (const def of this.defs.values()) {
      const existing = [...this.instances.values()].filter((i) => i.agentName === def.config.name);
      for (let n = existing.length + 1; n <= def.config.instances; n++) {
        this.spawn(def.config.name);
      }
    }
  }

  spawn(agentName: string): AgentInstance {
    const def = this.defs.get(agentName);
    if (!def) throw new Error(`agente "${agentName}" não existe`);
    const siblings = [...this.instances.keys()].filter((id) => id.startsWith(agentName + '-'));
    let n = siblings.length + 1;
    while (this.instances.has(`${agentName}-${n}`)) n++;
    const id = `${agentName}-${n}`;
    const deskIndex = this.nextDesk();
    const inst = this.makeInstance(id, def, deskIndex);
    this.instances.set(id, inst);
    inst.persist();
    inst.log('system', `Instância criada (modelo ${def.config.model}).`);
    this.hub.broadcast({ type: 'instance_update', instance: inst.toInfo() });
    return inst;
  }

  remove(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    inst.stop();
    this.instances.delete(instanceId);
    deleteInstance(this.db, instanceId);
    this.hub.broadcast({ type: 'instance_removed', instanceId });
  }

  private nextDesk(): number {
    const used = new Set([...this.instances.values()].map((i) => i.deskIndex));
    let n = 0;
    while (used.has(n)) n++;
    return n;
  }

  private makeInstance(
    id: string,
    def: AgentDefinition,
    deskIndex: number,
    workdir?: string,
  ): AgentInstance {
    return new AgentInstance(
      id,
      def,
      deskIndex,
      {
        db: this.db,
        bus: this.bus,
        broadcast: (ev) => this.hub.broadcast(ev),
        models: this.models,
        resolveTarget: (from, name) => this.resolveTarget(from, name),
        budgetExceeded: () => this.budgetExceededAndNotify(),
        makeBusServer: (instance) => this.makeBusServer(instance),
        makeFileServer: (instance) => makeFileServer(instance),
        onUsage: () => this.hub.broadcast({ type: 'cost_update', cost: this.cost.summary() }),
      },
      workdir,
    );
  }

  /** Chamado quando o orçamento muda: destrava quem estava parado por isso. */
  releaseBudgetBlocked(): void {
    if (this.cost.exceeded()) return;
    for (const inst of this.instances.values()) inst.kickIfBlocked();
  }

  allInfos(): InstanceInfo[] {
    return [...this.instances.values()].map((i) => i.toInfo());
  }

  // -------------------------------------------------------------------------
  // Comunicação
  // -------------------------------------------------------------------------

  /**
   * Resolve um destino ("human", "reviewer", "dev-2") para um id entregável,
   * aplicando can_talk_to do remetente. Null = não permitido/inexistente.
   */
  resolveTarget(from: AgentInstance, name: string): string | null {
    if (name === HUMAN) return HUMAN;

    // instância exata?
    const direct = this.instances.get(name);
    if (direct) {
      const ok = checkCanTalkTo(from.def.config, direct.agentName);
      if (!ok.allowed && direct.agentName !== from.agentName) {
        from.log('permission', `BLOQUEADO falar com ${name}: ${ok.reason}`);
        return null;
      }
      return direct.id;
    }

    // tipo de agente: escolhe uma instância (preferindo ociosa)
    const ok = checkCanTalkTo(from.def.config, name);
    if (!ok.allowed) {
      from.log('permission', `BLOQUEADO falar com ${name}: ${ok.reason}`);
      return null;
    }
    const candidates = [...this.instances.values()].filter(
      (i) => i.agentName === name && !i.isStopped,
    );
    if (candidates.length === 0) return null;
    const idle = candidates.find((i) => i.state === 'idle');
    return (idle ?? candidates[0]).id;
  }

  private budgetExceededAndNotify(): boolean {
    if (!this.cost.exceeded()) return false;
    this.hub.broadcast({
      type: 'toast',
      level: 'warn',
      text: 'Limite de gasto atingido — agentes pausados. Aumente o orçamento para continuar.',
    });
    return true;
  }

  /** Ferramentas MCP do barramento, com can_talk_to aplicado no backend. */
  private makeBusServer(instance: AgentInstance): Record<string, unknown> {
    const resolve = (to: string): string | null => this.resolveTarget(instance, to);

    const err = (text: string) => ({
      content: [{ type: 'text' as const, text: `ERRO: ${text}` }],
      isError: true,
    });
    const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });

    return createSdkMcpServer({
      name: 'bus',
      version: '1.0.0',
      tools: [
        tool(
          'send_message',
          'Envia uma mensagem a outro agente (ex. "reviewer", "dev-2") ou ao humano ("human"). Não espera resposta.',
          { to: z.string(), content: z.string() },
          async (args) => {
            const target = resolve(args.to);
            if (!target) return err(`você não pode falar com "${args.to}" (can_talk_to) ou o destino não existe`);
            instance.markInteraction(target);
            this.bus.send(instance.id, target, args.content);
            setTimeout(() => instance.markInteraction(null), 4000);
            return ok(`mensagem entregue a ${target}`);
          },
        ),
        tool(
          'ask_question',
          'Faz uma pergunta a outro agente ou ao humano e ESPERA a resposta. Use quando tiver dúvida que bloqueia o trabalho.',
          { to: z.string(), content: z.string() },
          async (args) => {
            const target = resolve(args.to);
            if (!target) return err(`você não pode falar com "${args.to}" (can_talk_to) ou o destino não existe`);
            const prev = instance.state;
            instance.setState('waiting', { interactingWith: target });
            try {
              const reply = await this.bus.ask(instance.id, target, args.content);
              return ok(`Resposta de ${reply.from}: ${reply.content}`);
            } finally {
              if (!instance.isStopped && !instance.isPaused) {
                instance.setState(prev === 'waiting' ? 'working' : prev, { interactingWith: null });
              }
            }
          },
        ),
        tool(
          'request_permission',
          'Pede permissão a outro agente ou ao humano antes de uma ação sensível e ESPERA a decisão.',
          { to: z.string(), action: z.string(), reason: z.string().optional() },
          async (args) => {
            const target = resolve(args.to);
            if (!target) return err(`você não pode falar com "${args.to}" (can_talk_to) ou o destino não existe`);
            const prev = instance.state;
            instance.setState('waiting', { interactingWith: target });
            try {
              const reply = await this.bus.requestPermission(
                instance.id,
                target,
                `${args.action}${args.reason ? ` — motivo: ${args.reason}` : ''}`,
                null,
                null,
              );
              return reply.approved
                ? ok(`APROVADO por ${reply.from}: ${reply.content}`)
                : ok(`NEGADO por ${reply.from}: ${reply.content}. Não execute a ação.`);
            } finally {
              if (!instance.isStopped && !instance.isPaused) {
                instance.setState(prev === 'waiting' ? 'working' : prev, { interactingWith: null });
              }
            }
          },
        ),
        tool(
          'request_meeting',
          'Convoca uma reunião com outros agentes (ids de instância, ex. ["dev-1","dev-2"]). A reunião tem pauta, rodadas moderadas e gera resumo.',
          {
            title: z.string(),
            agenda: z.string(),
            participants: z.array(z.string()),
            rounds: z.number().int().min(1).max(10).optional(),
          },
          async (args) => {
            if (!this.meetings) return err('serviço de reuniões indisponível');
            try {
              const meeting = this.meetings.start({
                title: args.title,
                agenda: args.agenda,
                participants: [...args.participants, instance.id],
                startedBy: instance.id,
                maxRounds: args.rounds,
              });
              return ok(
                `reunião ${meeting.id} convocada. Você será chamado para falar nas rodadas; aguarde.`,
              );
            } catch (e) {
              return err(e instanceof Error ? e.message : String(e));
            }
          },
        ),
        tool(
          'respond',
          'Responde a uma pergunta ou pedido de permissão recebido (use o request_id informado na mensagem).',
          {
            request_id: z.string(),
            text: z.string(),
            approve: z.boolean().optional(),
          },
          async (args) => {
            const result = this.bus.tryRespond(args.request_id, instance.id, {
              approved: args.approve,
              text: args.text,
            });
            // resposta tardia (pedido já escalado/resolvido) não é erro:
            // o agente só precisa saber que pode seguir em frente.
            return ok(result.ok ? 'resposta entregue' : result.notice);
          },
        ),
      ],
    }) as unknown as Record<string, unknown>;
  }
}

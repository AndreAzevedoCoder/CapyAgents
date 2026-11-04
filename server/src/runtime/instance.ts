import fs from 'node:fs';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentDefinition,
  AgentState,
  InstanceInfo,
  ModelInfo,
  ServerEvent,
} from '@agent-office/shared';
import { HUMAN } from '@agent-office/shared';
import type { Db } from '../db/database.js';
import { insertLog, recordUsage, saveInstance } from '../db/database.js';
import type { MessageBus } from '../bus/bus.js';
import { checkToolUse, expandToolGroups } from '../permissions/engine.js';
import { computeCost } from '../cost/cost.js';
import { agentEnv, ROOT_DIR, WORKSPACE_DIR } from '../env.js';
import type { LogKind } from '@agent-office/shared';

export interface InstanceDeps {
  db: Db;
  bus: MessageBus;
  broadcast: (ev: ServerEvent) => void;
  models: ModelInfo[];
  /** Resolve nome de agente/instância para um id entregável ("human" incluso). Null = inexistente. */
  resolveTarget: (fromInstance: AgentInstance, name: string) => string | null;
  /** true = orçamento estourado; novas rodadas devem ser bloqueadas. */
  budgetExceeded: () => boolean;
  /** Servidor MCP com as ferramentas do barramento para esta instância. */
  makeBusServer: (instance: AgentInstance) => Record<string, unknown>;
  /** Chamado após cada registro de uso (para atualizar custo/orçamento na UI). */
  onUsage?: () => void;
}

export interface QueueOpts {
  /** Execução de pipeline à qual o turno pertence (atribuição de custo). */
  runId?: string | null;
  /** Diretório de trabalho só para este turno (worktrees de pipeline). */
  workdir?: string;
  /** Fura a fila (turnos de reunião). */
  front?: boolean;
  /** Turno de conversa pura: sem ferramentas (falas de reunião, resumos). */
  noTools?: boolean;
}

export interface QueueItem {
  prompt: string;
  /** Rótulo curto exibido como tarefa atual. */
  label: string;
  runId: string | null;
  workdir?: string;
  noTools?: boolean;
  resolve?: (resultText: string) => void;
  reject?: (err: Error) => void;
}

/**
 * Uma instância viva de um agente (ex. dev-1): sessão própria do SDK,
 * fila de entrada, estado visível e contabilidade de tokens.
 *
 * Mensagens recebidas enquanto o agente trabalha entram na fila e são
 * entregues no próximo ponto seguro (entre turnos).
 */
export class AgentInstance {
  state: AgentState = 'idle';
  task: string | null = null;
  interactingWith: string | null = null;
  meetingId: string | null = null;
  deskIndex: number;
  hat: string;
  sessionId: string | null = null;
  workdir: string;
  tokensIn = 0;
  tokensOut = 0;
  costUsd = 0;

  private queue: QueueItem[] = [];
  private looping = false;
  private paused = false;
  private stopped = false;
  private currentAbort: AbortController | null = null;
  private currentItem: QueueItem | null = null;
  /** Worktree do turno atual: confina o acesso enquanto durar a etapa. */
  private currentScopeDir: string | null = null;

  constructor(
    readonly id: string,
    readonly def: AgentDefinition,
    deskIndex: number,
    private deps: InstanceDeps,
    workdir?: string,
  ) {
    this.deskIndex = deskIndex;
    this.hat = def.config.hat;
    // sem worktree, o agente trabalha no workspace (nunca na raiz do repo)
    this.workdir = workdir ?? WORKSPACE_DIR;
  }

  get agentName(): string {
    return this.def.config.name;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  toInfo(): InstanceInfo {
    return {
      id: this.id,
      agent: this.agentName,
      model: this.def.config.model,
      hat: this.hat,
      state: this.state,
      task: this.task,
      interactingWith: this.interactingWith,
      meetingId: this.meetingId,
      location: this.meetingId
        ? { kind: 'meeting', roomIndex: 0, seatIndex: this.deskIndex % 6 }
        : { kind: 'desk', deskIndex: this.deskIndex },
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      costUsd: this.costUsd,
      queuedMessages: this.queue.length,
      workdir: this.workdir === WORKSPACE_DIR ? null : this.workdir,
    };
  }

  log(kind: LogKind, text: string, data?: unknown): void {
    const entry = insertLog(this.deps.db, this.id, kind, text, data);
    this.deps.broadcast({ type: 'log', entry });
  }

  setState(state: AgentState, opts?: { task?: string | null; interactingWith?: string | null }): void {
    this.state = state;
    if (opts && 'task' in opts) this.task = opts.task ?? null;
    if (opts && 'interactingWith' in opts) this.interactingWith = opts.interactingWith ?? null;
    this.persist();
    this.deps.broadcast({ type: 'instance_update', instance: this.toInfo() });
  }

  persist(): void {
    saveInstance(this.deps.db, {
      id: this.id,
      agent: this.agentName,
      model: this.def.config.model,
      hat: this.hat,
      state: this.state,
      task: this.task,
      workdir: this.workdir,
      session_id: this.sessionId,
      desk_index: this.deskIndex,
    });
  }

  /** Coloca trabalho na fila. Retorna promise do texto final do turno. */
  request(prompt: string, label: string, opts: QueueOpts = {}): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const item: QueueItem = {
        prompt,
        label,
        runId: opts.runId ?? null,
        workdir: opts.workdir,
        noTools: opts.noTools,
        resolve,
        reject,
      };
      if (opts.front) this.queue.unshift(item);
      else this.queue.push(item);
      this.deps.broadcast({ type: 'instance_update', instance: this.toInfo() });
      void this.loop();
    });
  }

  /** Enfileira sem esperar resultado (chat do humano, mensagens do barramento). */
  enqueue(prompt: string, label: string, opts: QueueOpts = {}): void {
    const item: QueueItem = {
      prompt,
      label,
      runId: opts.runId ?? null,
      workdir: opts.workdir,
      noTools: opts.noTools,
    };
    if (opts.front) this.queue.unshift(item);
    else this.queue.push(item);
    this.deps.broadcast({ type: 'instance_update', instance: this.toInfo() });
    void this.loop();
  }

  pause(): void {
    if (this.stopped) return;
    this.paused = true;
    this.currentAbort?.abort();
    this.setState('paused');
    this.log('system', 'Pausado pelo usuário.');
  }

  resume(): void {
    if (this.stopped) return;
    if (!this.paused) return;
    this.paused = false;
    this.log('system', 'Retomado pelo usuário.');
    if (this.queue.length === 0 && this.task) {
      // Turno interrompido no meio: peça para continuar de onde parou.
      this.queue.push({
        prompt:
          'Você foi pausado no meio do trabalho e acaba de ser retomado. Continue a tarefa de onde parou.',
        label: this.task,
        runId: null,
      });
    }
    this.setState(this.queue.length ? 'working' : 'idle');
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.currentAbort?.abort();
    const pending = [...this.queue];
    this.queue.length = 0;
    for (const item of pending) {
      item.reject?.(new Error(`${this.id} foi encerrado`));
    }
    this.setState('done', { task: null });
    this.log('system', 'Encerrado pelo usuário.');
  }

  // -------------------------------------------------------------------------

  private async loop(): Promise<void> {
    if (this.looping || this.paused || this.stopped) return;
    this.looping = true;
    try {
      while (!this.paused && !this.stopped && this.queue.length > 0) {
        if (this.deps.budgetExceeded()) {
          this.setState('blocked');
          this.log('system', 'Limite de gasto atingido — execução pausada. Ajuste o orçamento para continuar.');
          return;
        }
        const item = this.queue.shift()!;
        await this.runTurn(item);
      }
      if (!this.paused && !this.stopped && this.state !== 'blocked' && this.state !== 'error') {
        this.setState(this.meetingId ? 'in_meeting' : 'idle', {
          task: this.meetingId ? this.task : null,
          interactingWith: null,
        });
      }
    } finally {
      this.looping = false;
    }
  }

  private async runTurn(item: QueueItem): Promise<void> {
    this.currentItem = item;
    this.currentAbort = new AbortController();
    this.setState(this.meetingId ? 'in_meeting' : 'working', { task: item.label });
    this.log('message', `» ${item.label}`, { prompt: item.prompt });

    const config = this.def.config;
    const model = this.deps.models.find((m) => m.id === config.model);
    const turnWorkdir = item.workdir ?? this.workdir;
    if (item.workdir) {
      this.workdir = item.workdir; // visível no painel enquanto durar a etapa
      this.currentScopeDir = item.workdir; // confina o acesso à worktree
    } else {
      this.currentScopeDir = null;
    }

    const options: Options = {
      model: config.model,
      cwd: turnWorkdir,
      // Numa etapa com worktree, o único diretório acessível é a worktree —
      // senão o SDK auto-permite escrita no workspace compartilhado (listado em
      // paths.allow) e os devs gravam lá em vez de na própria worktree.
      additionalDirectories: (this.currentScopeDir
        ? [this.currentScopeDir]
        : config.paths.allow
            .map((p) => (p.startsWith('/') ? p : `${ROOT_DIR}/${p.replace(/^\.\//, '')}`))
            .filter((p) => !p.startsWith(turnWorkdir))
      // o CLI aborta (exit 1) se um diretório da lista não existe no disco
      ).filter((p) => fs.existsSync(p)),
      abortController: this.currentAbort,
      resume: this.sessionId ?? undefined,
      env: agentEnv(),
      settingSources: [],
      // captura o stderr do processo do CLI para diagnosticar crashes (exit 1)
      stderr: (data: string) => {
        const t = data.trim();
        if (t) this.log('error', `[cli] ${t.slice(0, 500)}`);
      },
      systemPrompt: this.buildSystemPrompt(),
      tools: item.noTools ? [] : this.builtinTools(),
      disallowedTools: ['Task', ...expandToolGroups(config.tools.deny)],
      mcpServers: item.noTools ? {} : { bus: this.deps.makeBusServer(this) as never },
      maxTurns: item.noTools ? 4 : config.max_turns,
      // Duas camadas de aplicação no backend (o prompt nunca é confiável):
      // 1. PreToolUse intercepta TODA chamada de ferramenta (inclusive as que o
      //    CLI auto-aprovaria, como Read) e aplica o agent.json.
      // 2. canUseTool cobre pedidos de permissão que cheguem por outros caminhos.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== 'PreToolUse') return {};
                const decision = await this.enforce(
                  input.tool_name,
                  (input.tool_input ?? {}) as Record<string, unknown>,
                );
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: decision.behavior,
                    permissionDecisionReason: decision.message,
                  },
                };
              },
            ],
            // aprovações podem levar minutos (outro agente ou o humano decide)
            timeout: 3600,
          },
        ],
      },
      canUseTool: async (toolName, input) => {
        const decision = await this.enforce(toolName, input);
        return decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: decision.message };
      },
    };

    let resultText = '';
    try {
      for await (const msg of query({ prompt: item.prompt, options })) {
        if (this.stopped) break;
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              this.log('thinking', block.text);
            } else if (block.type === 'thinking' && block.thinking?.trim()) {
              this.log('thinking', `(raciocínio) ${block.thinking.slice(0, 600)}`);
            } else if (block.type === 'tool_use') {
              this.log('tool', `${block.name}`, block.input);
            }
          }
        } else if (msg.type === 'user' && !('isReplay' in msg)) {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const text =
                  typeof block.content === 'string'
                    ? block.content
                    : (block.content ?? [])
                        .map((c: any) => (c.type === 'text' ? c.text : ''))
                        .join('');
                this.log('tool_result', text.slice(0, 2000) || '(sem saída)');
              }
            }
          }
        } else if (msg.type === 'result') {
          this.sessionId = msg.session_id;
          // o SDK referencia os tipos de usage de um pacote não instalado; o shape é estável
          const usage = msg.usage as unknown as import('../cost/cost.js').UsageLike;
          const { tokensIn, tokensOut, costUsd } = computeCost(model, usage);
          this.tokensIn += tokensIn;
          this.tokensOut += tokensOut;
          this.costUsd += costUsd;
          recordUsage(this.deps.db, this.id, item.runId, tokensIn, tokensOut, costUsd);
          this.deps.onUsage?.();
          if (msg.subtype === 'success') {
            resultText = msg.result;
          } else {
            resultText = `[${msg.subtype}]`;
            this.log('error', `Turno terminou com ${msg.subtype}`);
          }
          this.persist();
        }
      }
      item.resolve?.(resultText);
    } catch (err) {
      const aborted =
        this.currentAbort.signal.aborted ||
        (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        // pausa ou encerramento: devolve o item se foi pausa de pipeline
        item.reject?.(new Error('interrompido'));
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `Erro no turno: ${msg}`);
      this.setState('error');
      item.reject?.(err instanceof Error ? err : new Error(msg));
    } finally {
      this.currentItem = null;
      this.currentAbort = null;
    }
  }

  private builtinTools(): string[] {
    const allowed = expandToolGroups(this.def.config.tools.allow);
    // TodoWrite ajuda o agente a se organizar e alimenta o painel de tarefa.
    return [...new Set([...allowed, 'TodoWrite'])];
  }

  private buildSystemPrompt(): string {
    const config = this.def.config;
    const talks = [...config.can_talk_to, HUMAN].join(', ');
    const approvals = Object.entries(config.requires_approval_from)
      .map(([tool, who]) => `${tool} (aprovador: ${who})`)
      .join(', ');
    return [
      `Você é "${this.id}", uma instância do agente "${config.name}" em uma equipe de agentes.`,
      '',
      this.def.instructions.trim(),
      '',
      '## Regras do runtime (não negociáveis)',
      `- Seu diretório de trabalho é ${this.workdir}.`,
      `- Comunicação com a equipe: ferramentas do servidor MCP "bus" (send_message, ask_question, request_permission, respond). Você só pode falar com: ${talks}.`,
      '- Pergunte (ask_question) quando tiver dúvida que bloqueie o trabalho; a execução espera a resposta.',
      '- As permissões de ferramentas e caminhos são aplicadas pelo sistema. Se uma ação for bloqueada, NÃO insista: ajuste a abordagem ou pergunte a quem pode aprovar.',
      `- Ferramentas que EXIGEM aprovação (cada uso para a sua execução até alguém decidir): ${approvals || 'nenhuma'}. As demais ferramentas permitidas executam na hora — prefira-as. Em particular: explore e leia arquivos com Read/Glob/Grep (imediatas), nunca com comandos de shell.`,
      '- Ao receber um "Pedido de permissão" ou "Pergunta" de outro agente, responda usando a ferramenta respond com o id informado.',
      '- Ao concluir uma tarefa, termine com um parágrafo iniciado por "RESULTADO:" resumindo o que foi entregue (arquivos, decisões, pendências).',
    ].join('\n');
  }

  /**
   * Decisão central de permissão para UMA chamada de ferramenta.
   * Aplica tools/paths do agent.json e, se exigido, espera aprovação de outro
   * agente ou do humano pelo barramento. Toda negação é logada com o motivo.
   */
  private async enforce(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: 'allow' | 'deny'; message: string }> {
    const config = this.def.config;
    const decision = checkToolUse(config, ROOT_DIR, toolName, input, this.currentScopeDir ?? undefined);

    if (!decision.allowed) {
      this.log('permission', `BLOQUEADO ${toolName}: ${decision.reason}`, { toolName, input });
      return {
        behavior: 'deny',
        message: `Ação bloqueada pelo agent.json: ${decision.reason}. Ajuste a abordagem ou peça ajuda.`,
      };
    }

    if (decision.needsApprovalFrom) {
      const target = this.deps.resolveTarget(this, decision.needsApprovalFrom);
      if (!target) {
        this.log('permission', `BLOQUEADO ${toolName}: aprovador "${decision.needsApprovalFrom}" indisponível`);
        return {
          behavior: 'deny',
          message: `Aprovador "${decision.needsApprovalFrom}" não está disponível; a ação não pode ser executada.`,
        };
      }
      this.log('permission', `Aguardando aprovação de ${target} para ${toolName}`, { input });
      const prevState = this.state;
      this.setState('waiting', { interactingWith: target });
      try {
        const reply = await this.deps.bus.requestPermission(
          this.id,
          target,
          `${this.id} pede permissão para usar ${toolName}: ${summarizeInput(toolName, input)}`,
          toolName,
          input,
        );
        if (!reply.approved) {
          this.log('permission', `NEGADO por ${reply.from}: ${reply.content}`);
          return {
            behavior: 'deny',
            message: `Permissão negada por ${reply.from}: ${reply.content}`,
          };
        }
        this.log('permission', `Aprovado por ${reply.from}`);
      } finally {
        if (!this.stopped) this.setState(prevState === 'waiting' ? 'working' : prevState, { interactingWith: null });
      }
    }

    return { behavior: 'allow', message: decision.reason };
  }

  /** Usado pelo barramento/reuniões para marcar interação visível no 3D. */
  markInteraction(withId: string | null): void {
    this.interactingWith = withId;
    this.deps.broadcast({ type: 'instance_update', instance: this.toInfo() });
  }
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') return input.command.slice(0, 300);
  if (typeof input.file_path === 'string') return input.file_path;
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

import { EventEmitter } from 'node:events';
import type { BusMessage, BusMessageType } from '@capyagents/shared';
import { HUMAN } from '@capyagents/shared';
import { newId } from '../ids.js';

/**
 * Barramento de mensagens tipadas entre agentes (e o humano).
 *
 * - `message`: entrega simples, sem resposta.
 * - `question`: bloqueia o remetente (estado waiting) até a resposta.
 * - `permission_request` / `permission_response`: aprovação de ações.
 *
 * Pedidos sem resposta no prazo são ESCALADOS para o humano (não expiram).
 * Ciclos de espera (A aguarda B que aguarda A) são detectados na criação
 * e escalados imediatamente.
 */

export interface BusEvents {
  message: (m: BusMessage) => void;
  /** Mensagem precisa ser entregue na fila do destinatário. */
  deliver: (m: BusMessage) => void;
  /** Pedido escalado para o humano (timeout ou ciclo). */
  escalated: (m: BusMessage, reason: string) => void;
}

interface PendingWait {
  resolve: (reply: BusMessage) => void;
  timer: NodeJS.Timeout | null;
}

export class MessageBus extends EventEmitter {
  /** mensagens pendentes aguardando resposta, por id. */
  private pending = new Map<string, PendingWait>();
  /** grafo de espera: quem (chave) está aguardando quem (valor). */
  private waitingOn = new Map<string, string>();
  /** todas as mensagens vivas nesta sessão (histórico vem do DB). */
  readonly messages = new Map<string, BusMessage>();

  constructor(private timeoutMs = 120_000) {
    super();
  }

  on<E extends keyof BusEvents>(event: E, listener: BusEvents[E]): this {
    return super.on(event, listener);
  }
  emit<E extends keyof BusEvents>(event: E, ...args: Parameters<BusEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  /** Quem está aguardando resposta de quem (para UI e detecção de ciclo). */
  getWaitingOn(from: string): string | undefined {
    return this.waitingOn.get(from);
  }

  pendingFor(target: string): BusMessage[] {
    return [...this.messages.values()].filter(
      (m) => m.to === target && (m.status === 'pending' || m.status === 'escalated'),
    );
  }

  /** Mensagem simples (fire-and-forget). */
  send(from: string, to: string, content: string): BusMessage {
    const m = this.create('message', from, to, content);
    m.status = 'delivered';
    this.emit('message', m);
    this.emit('deliver', m);
    return m;
  }

  /**
   * Pergunta que bloqueia o remetente até a resposta.
   * Detecta ciclo de espera antes de registrar; se houver, escala para o humano.
   */
  ask(from: string, to: string, content: string): Promise<BusMessage> {
    const m = this.create('question', from, to, content);
    return this.waitFor(m, from, to);
  }

  /** Pedido de permissão (bloqueia até permission_response). */
  requestPermission(
    from: string,
    to: string,
    content: string,
    tool: string | null,
    toolInput: unknown,
  ): Promise<BusMessage> {
    const m = this.create('permission_request', from, to, content, { tool, toolInput });
    return this.waitFor(m, from, to);
  }

  /**
   * Versão tolerante de respond(): se o pedido já foi resolvido (ex.: escalado
   * ao humano por timeout e decidido antes), devolve um aviso em vez de erro —
   * o aprovador original não deve desperdiçar turnos com falhas.
   */
  tryRespond(
    messageId: string,
    responder: string,
    opts: { approved?: boolean; text?: string },
  ): { ok: true; reply: BusMessage } | { ok: false; notice: string } {
    const original = this.messages.get(messageId);
    if (!original) {
      return { ok: false, notice: `pedido ${messageId} não encontrado` };
    }
    if (original.status !== 'pending' && original.status !== 'escalated') {
      const outcome =
        original.status === 'approved'
          ? 'APROVADO'
          : original.status === 'denied'
            ? 'NEGADO'
            : 'respondido';
      return {
        ok: false,
        notice:
          `este pedido já foi resolvido (${outcome}) antes da sua resposta — ` +
          'provavelmente escalado ao humano por timeout. Nenhuma ação é necessária; siga em frente.',
      };
    }
    return { ok: true, reply: this.respond(messageId, responder, opts) };
  }

  /**
   * Responde a uma pergunta ou pedido de permissão.
   * `responder` pode ser um agente ou o humano (pela interface).
   */
  respond(
    messageId: string,
    responder: string,
    opts: { approved?: boolean; text?: string },
  ): BusMessage {
    const original = this.messages.get(messageId);
    if (!original) throw new Error(`mensagem ${messageId} não encontrada`);
    if (original.status !== 'pending' && original.status !== 'escalated') {
      throw new Error(`mensagem ${messageId} já foi resolvida (${original.status})`);
    }

    const isPermission = original.type === 'permission_request';
    const reply = this.create(
      isPermission ? 'permission_response' : 'message',
      responder,
      original.from,
      opts.text ?? (opts.approved ? 'aprovado' : 'negado'),
      {
        replyTo: original.id,
        approved: isPermission ? Boolean(opts.approved) : null,
      },
    );
    reply.status = 'delivered';

    original.status = isPermission ? (opts.approved ? 'approved' : 'denied') : 'answered';
    original.resolvedAt = Date.now();
    this.emit('message', original);
    this.emit('message', reply);

    const wait = this.pending.get(original.id);
    if (wait) {
      if (wait.timer) clearTimeout(wait.timer);
      this.pending.delete(original.id);
      this.waitingOn.delete(original.from);
      wait.resolve(reply);
    }
    return reply;
  }

  // -------------------------------------------------------------------------

  private create(
    type: BusMessageType,
    from: string,
    to: string,
    content: string,
    extra?: Partial<BusMessage>,
  ): BusMessage {
    const m: BusMessage = {
      id: newId('msg'),
      type,
      from,
      to,
      content,
      replyTo: null,
      tool: null,
      toolInput: null,
      approved: null,
      status: 'pending',
      createdAt: Date.now(),
      resolvedAt: null,
      ...extra,
    };
    this.messages.set(m.id, m);
    return m;
  }

  private waitFor(m: BusMessage, from: string, to: string): Promise<BusMessage> {
    // Detecção de ciclo: seguindo o grafo de espera a partir do destinatário,
    // chegamos de volta ao remetente?
    const cycle = this.findCycle(from, to);
    if (cycle) {
      return this.escalate(m, `ciclo de espera detectado: ${cycle.join(' -> ')}`);
    }

    this.emit('message', m);
    if (to !== HUMAN) this.emit('deliver', m);

    this.waitingOn.set(from, to);
    return new Promise<BusMessage>((resolve) => {
      const timer =
        to === HUMAN
          ? null // pedidos ao humano não expiram
          : setTimeout(() => {
              void this.escalateInPlace(m, `sem resposta de ${to} em ${this.timeoutMs / 1000}s`, resolve);
            }, this.timeoutMs);
      this.pending.set(m.id, { resolve, timer });
    });
  }

  private findCycle(from: string, to: string): string[] | null {
    const chain = [from, to];
    let cursor: string | undefined = to;
    const seen = new Set([from]);
    while (cursor) {
      if (cursor === from) return chain;
      if (seen.has(cursor)) return null; // ciclo que não envolve o remetente
      seen.add(cursor);
      cursor = this.waitingOn.get(cursor);
      if (cursor) chain.push(cursor);
    }
    return null;
  }

  /** Escala um pedido recém-criado (ciclo detectado antes da entrega). */
  private escalate(m: BusMessage, reason: string): Promise<BusMessage> {
    m.to = HUMAN;
    m.status = 'escalated';
    m.content = `[escalado: ${reason}] ${m.content}`;
    this.emit('message', m);
    this.emit('escalated', m, reason);
    this.waitingOn.set(m.from, HUMAN);
    return new Promise<BusMessage>((resolve) => {
      this.pending.set(m.id, { resolve, timer: null });
    });
  }

  /** Escala um pedido já pendente (timeout), mantendo a promise original. */
  private escalateInPlace(
    m: BusMessage,
    reason: string,
    _resolve: (r: BusMessage) => void,
  ): void {
    if (m.status !== 'pending') return;
    m.to = HUMAN;
    m.status = 'escalated';
    m.content = `[escalado: ${reason}] ${m.content}`;
    const wait = this.pending.get(m.id);
    if (wait) wait.timer = null;
    this.waitingOn.set(m.from, HUMAN);
    this.emit('message', m);
    this.emit('escalated', m, reason);
  }
}

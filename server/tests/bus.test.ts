import { describe, expect, it } from 'vitest';
import { MessageBus } from '../src/bus/bus.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('MessageBus', () => {
  it('entrega mensagem simples (message) como delivered', () => {
    const bus = new MessageBus();
    const delivered: string[] = [];
    bus.on('deliver', (m) => delivered.push(m.to));
    const m = bus.send('dev-1', 'reviewer-1', 'oi');
    expect(m.status).toBe('delivered');
    expect(delivered).toEqual(['reviewer-1']);
  });

  it('question bloqueia até respond e devolve a resposta', async () => {
    const bus = new MessageBus();
    bus.on('deliver', (m) => {
      if (m.type === 'question') {
        // o destinatário responde assincronamente
        setTimeout(() => bus.respond(m.id, 'reviewer-1', { text: 'use zod' }), 10);
      }
    });
    const reply = await bus.ask('dev-1', 'reviewer-1', 'qual lib de validação?');
    expect(reply.content).toBe('use zod');
    expect(reply.from).toBe('reviewer-1');
    expect(bus.getWaitingOn('dev-1')).toBeUndefined();
  });

  it('permission_request aprovado e negado', async () => {
    const bus = new MessageBus();
    bus.on('deliver', (m) => {
      if (m.type === 'permission_request') {
        const approve = m.content.includes('npm test');
        setTimeout(() => bus.respond(m.id, 'reviewer-1', { approved: approve, text: 'ok' }), 5);
      }
    });
    const ok = await bus.requestPermission('dev-1', 'reviewer-1', 'rodar npm test', 'Bash', {});
    expect(ok.approved).toBe(true);
    const no = await bus.requestPermission('dev-1', 'reviewer-1', 'rodar rm -rf /', 'Bash', {});
    expect(no.approved).toBe(false);
  });

  it('escala para o humano quando o prazo estoura', async () => {
    const bus = new MessageBus(20); // timeout de 20ms
    const escalated: string[] = [];
    bus.on('escalated', (m, reason) => escalated.push(reason));
    const promise = bus.ask('dev-1', 'reviewer-1', 'alguém aí?');
    await tick(40);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toContain('sem resposta');
    // o pedido agora pertence ao humano e ainda pode ser respondido
    const pending = bus.pendingFor('human');
    expect(pending).toHaveLength(1);
    bus.respond(pending[0].id, 'human', { text: 'estou aqui' });
    const reply = await promise;
    expect(reply.from).toBe('human');
  });

  it('detecta ciclo A->B->A e escala imediatamente', async () => {
    const bus = new MessageBus(10_000);
    const escalated: string[] = [];
    bus.on('escalated', (_m, reason) => escalated.push(reason));

    // A espera B (pergunta nunca respondida)
    const a = bus.ask('a-1', 'b-1', 'pergunta de A');
    // B pergunta de volta para A: ciclo
    const b = bus.ask('b-1', 'a-1', 'pergunta de B');

    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toContain('ciclo');

    // o humano resolve o pedido escalado de B; depois responde A normalmente
    const pendingHuman = bus.pendingFor('human');
    expect(pendingHuman.map((m) => m.from)).toEqual(['b-1']);
    bus.respond(pendingHuman[0].id, 'human', { text: 'decisão do humano' });
    expect((await b).content).toBe('decisão do humano');

    const pendingA = bus.pendingFor('b-1');
    expect(pendingA).toHaveLength(1);
    bus.respond(pendingA[0].id, 'b-1', { text: 'agora respondo' });
    expect((await a).content).toBe('agora respondo');
  });

  it('resposta tardia do aprovador original vira aviso, não erro', async () => {
    const bus = new MessageBus(20); // escala para o humano em 20ms
    const promise = bus.requestPermission('dev-1', 'reviewer-1', 'rodar teste', 'Bash', {});
    await tick(40); // escalou
    const pending = bus.pendingFor('human');
    bus.respond(pending[0].id, 'human', { approved: true, text: 'ok' });
    await promise;
    // reviewer responde depois: sem exceção, com aviso claro
    const late = bus.tryRespond(pending[0].id, 'reviewer-1', { approved: false, text: 'nego' });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.notice).toContain('já foi resolvido');
  });

  it('não permite responder duas vezes', async () => {
    const bus = new MessageBus();
    bus.on('deliver', (m) => {
      if (m.type === 'question') setTimeout(() => bus.respond(m.id, 'b-1', { text: 'x' }), 5);
    });
    const reply = await bus.ask('a-1', 'b-1', '?');
    expect(() => bus.respond(reply.replyTo!, 'b-1', { text: 'y' })).toThrow(/já foi resolvida/);
  });
});

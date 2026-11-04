import type { Meeting } from '@capyagents/shared';
import { HUMAN } from '@capyagents/shared';
import type { Db } from '../db/database.js';
import { loadMeetings, saveMeeting, saveMeetingTurn } from '../db/database.js';
import type { Hub } from '../hub.js';
import type { RuntimeManager } from '../runtime/manager.js';
import { newId } from '../ids.js';

/**
 * Reuniões 1:1 ou em grupo com pauta, turnos moderados e limite de rodadas.
 * Ao final, a transcrição e um resumo com decisões/próximos passos são salvos
 * e injetados no contexto de cada participante.
 */
export class MeetingService {
  private meetings = new Map<string, Meeting>();
  private nextRoom = 0;

  constructor(
    private db: Db,
    private hub: Hub,
    private manager: RuntimeManager,
  ) {
    for (const m of loadMeetings(this.db)) {
      // reuniões interrompidas por reinício são encerradas sem resumo
      if (m.status !== 'done' && m.status !== 'cancelled') {
        m.status = 'cancelled';
        m.endedAt = Date.now();
        saveMeeting(this.db, m);
      }
      this.meetings.set(m.id, m);
    }
  }

  all(): Meeting[] {
    return [...this.meetings.values()];
  }

  /**
   * Inicia uma reunião. `startedBy` é "human" ou um id de instância — nesse
   * caso, can_talk_to do iniciador precisa permitir todos os participantes.
   */
  start(opts: {
    title: string;
    agenda: string;
    participants: string[];
    startedBy: string;
    maxRounds?: number;
  }): Meeting {
    const participants = [...new Set(opts.participants)];
    const agentIds = participants.filter((p) => p !== HUMAN);
    if (agentIds.length === 0) throw new Error('reunião precisa de pelo menos um agente');
    for (const id of agentIds) {
      if (!this.manager.instances.get(id)) throw new Error(`participante "${id}" não existe`);
    }
    if (opts.startedBy !== HUMAN) {
      const starter = this.manager.instances.get(opts.startedBy);
      if (!starter) throw new Error(`iniciador "${opts.startedBy}" não existe`);
      for (const id of agentIds) {
        if (id === opts.startedBy) continue;
        if (!this.manager.resolveTarget(starter, id)) {
          throw new Error(`"${opts.startedBy}" não pode convocar "${id}" (can_talk_to)`);
        }
      }
    }

    const meeting: Meeting = {
      id: newId('meet'),
      title: opts.title,
      agenda: opts.agenda,
      participants,
      startedBy: opts.startedBy,
      maxRounds: Math.min(opts.maxRounds ?? 3, 10),
      currentRound: 0,
      status: 'gathering',
      roomIndex: this.nextRoom++ % 2,
      transcript: [],
      summary: null,
      createdAt: Date.now(),
      endedAt: null,
    };
    this.meetings.set(meeting.id, meeting);
    this.persist(meeting);
    void this.run(meeting).catch((err) => {
      meeting.status = 'cancelled';
      meeting.endedAt = Date.now();
      this.persist(meeting);
      this.hub.broadcast({
        type: 'toast',
        level: 'error',
        text: `Reunião "${meeting.title}" falhou: ${err instanceof Error ? err.message : err}`,
      });
    });
    return meeting;
  }

  private persist(meeting: Meeting): void {
    saveMeeting(this.db, meeting);
    this.hub.broadcast({ type: 'meeting_update', meeting: { ...meeting, transcript: [...meeting.transcript] } });
  }

  private async run(meeting: Meeting): Promise<void> {
    const agents = meeting.participants
      .filter((p) => p !== HUMAN)
      .map((id) => this.manager.instances.get(id)!)
      .filter(Boolean);

    // participantes caminham até a sala (o 3D reage a meetingId + estado)
    for (const inst of agents) {
      inst.meetingId = meeting.id;
      inst.setState('in_meeting', { interactingWith: null });
      inst.log('system', `Entrou na reunião "${meeting.title}".`);
    }

    meeting.status = 'in_progress';
    this.persist(meeting);

    try {
      for (let round = 1; round <= meeting.maxRounds; round++) {
        meeting.currentRound = round;
        this.persist(meeting);
        let allPassed = true;
        for (const inst of agents) {
          if (meeting.status !== 'in_progress') return;
          const transcript = meeting.transcript
            .map((t) => `${t.speaker}: ${t.text}`)
            .join('\n\n');
          const prompt = [
            `Reunião "${meeting.title}" — rodada ${round}/${meeting.maxRounds}.`,
            `Pauta: ${meeting.agenda}`,
            `Participantes: ${meeting.participants.join(', ')}.`,
            transcript ? `Transcrição até agora:\n\n${transcript}` : 'Você abre a reunião.',
            '',
            'É a sua vez de falar. Contribua de forma objetiva (no máximo 2 parágrafos), reagindo ao que já foi dito. NÃO use ferramentas nesta fala. Se não tiver nada a acrescentar, responda apenas "PASSO".',
          ].join('\n\n');
          let text: string;
          try {
            text = (
              await inst.request(prompt, `Reunião: ${meeting.title}`, { front: true, noTools: true })
            ).trim();
          } catch {
            // participante encerrado/indisponível: registra e segue sem matar a reunião
            text = '[não pôde participar desta rodada]';
          }
          const passed = /^PASSO\b/i.test(text) || text.startsWith('[não pôde');
          if (!passed) allPassed = false;
          const turn = { speaker: inst.id, text, round, ts: Date.now() };
          meeting.transcript.push(turn);
          saveMeetingTurn(this.db, meeting.id, turn);
          this.persist(meeting);
        }
        if (allPassed) break;
      }

      // resumo: quem convocou (ou o primeiro agente disponível) consolida decisões
      meeting.status = 'summarizing';
      this.persist(meeting);
      const scribe =
        agents.find((a) => a.id === meeting.startedBy && !a.isStopped) ??
        agents.find((a) => !a.isStopped) ??
        agents[0];
      let summary: string;
      try {
        summary = await scribe.request(
          [
            `A reunião "${meeting.title}" terminou. Pauta: ${meeting.agenda}`,
            'Transcrição completa:',
            meeting.transcript.map((t) => `${t.speaker}: ${t.text}`).join('\n\n'),
            '',
            'Escreva um resumo curto com: (1) decisões tomadas; (2) próximos passos com responsável. Não use ferramentas.',
          ].join('\n\n'),
          `Resumo da reunião: ${meeting.title}`,
          { front: true, noTools: true },
        );
      } catch {
        // não foi possível gerar o resumo (ex.: todos os participantes encerrados):
        // preserva a transcrição e encerra a reunião mesmo assim.
        summary =
          'Reunião encerrada sem resumo automático (participante indisponível). ' +
          'A transcrição completa está preservada acima.';
      }
      meeting.summary = summary;
      meeting.status = 'done';
      meeting.endedAt = Date.now();
      this.persist(meeting);

      // injeta o resumo no contexto dos demais participantes (os ativos)
      for (const inst of agents) {
        if (inst !== scribe && !inst.isStopped) {
          inst.enqueue(
            `Resumo da reunião "${meeting.title}" (guarde para seu trabalho; não precisa responder):\n\n${summary}`,
            `Resumo: ${meeting.title}`,
          );
        }
      }
    } finally {
      for (const inst of agents) {
        inst.meetingId = null;
        inst.log('system', `Saiu da reunião "${meeting.title}".`);
        if (inst.state === 'in_meeting') {
          inst.setState(inst.queuedCount > 0 ? 'working' : 'idle');
        } else {
          // reemite o estado atual para o 3D recalcular a posição (volta à mesa)
          inst.setState(inst.state);
        }
      }
    }
  }
}

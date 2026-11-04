import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientCommand, ServerEvent, ServerReply } from '@capyagents/shared';
import { HUMAN } from '@capyagents/shared';
import type { Db } from '../db/database.js';
import { getLogs } from '../db/database.js';
import type { Hub } from '../hub.js';
import type { RuntimeManager } from '../runtime/manager.js';
import type { PipelineExecutor } from '../pipelines/executor.js';
import type { MeetingService } from '../meetings/meetings.js';
import { saveAgent, deleteAgent, loadAgents } from '../agents/registry.js';
import type { ModelInfo } from '@capyagents/shared';
import { listHats } from '../http/hats.js';
import { ASSETS_DIR, HOST, PORT, REPO_DIR } from '../env.js';

export interface AppContext {
  db: Db;
  hub: Hub;
  manager: RuntimeManager;
  executor: PipelineExecutor;
  meetings: MeetingService;
  models: ModelInfo[];
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveFile(res: http.ServerResponse, file: string): boolean {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    // o frontend em dev roda em outra porta local (Vite)
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

export function startServer(ctx: AppContext): http.Server {
  const webDist = path.join(REPO_DIR, 'web', 'dist');

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === '/assets/bear.glb') {
      // serve a versão decimada quando existir (gerada em npm run setup)
      const optimized = path.join(ASSETS_DIR, 'bear-optimized.glb');
      const original = path.join(ASSETS_DIR, 'Meshy_AI_Sunny_Fluffbear_1103224035_texture.glb');
      if (serveFile(res, fs.existsSync(optimized) ? optimized : original)) return;
    }
    if (url.startsWith('/assets/')) {
      const rel = path.normalize(url.slice('/assets/'.length));
      if (!rel.startsWith('..') && serveFile(res, path.join(ASSETS_DIR, rel))) return;
    }
    // build de produção do frontend (npm run build); em dev o Vite serve a UI
    if (fs.existsSync(webDist)) {
      const rel = url === '/' ? 'index.html' : path.normalize(url.slice(1));
      if (!rel.startsWith('..')) {
        if (serveFile(res, path.join(webDist, rel))) return;
        if (serveFile(res, path.join(webDist, 'index.html'))) return;
      }
    }
    res.writeHead(404);
    res.end('not found');
  });

  const wss = new WebSocketServer({ server });

  const sendTo = (socket: WebSocket, data: ServerEvent | ServerReply): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  };

  ctx.hub.onEvent((ev) => {
    for (const socket of wss.clients) sendTo(socket, ev);
  });

  wss.on('connection', (socket) => {
    sendTo(socket, snapshot(ctx));
    socket.on('message', (raw) => {
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        handleCommand(ctx, cmd, (reply) => sendTo(socket, reply));
      } catch (err) {
        sendTo(socket, {
          type: 'toast',
          level: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`CapyAgents em http://${HOST}:${PORT}`);
  });
  return server;
}

export function snapshot(ctx: AppContext): ServerEvent {
  return {
    type: 'snapshot',
    agents: [...ctx.manager.defs.values()],
    instances: ctx.manager.allInfos(),
    pendingForHuman: ctx.manager.bus.pendingFor(HUMAN),
    pipelines: [...ctx.executor.defs.values()],
    runs: ctx.executor.allRuns(),
    meetings: ctx.meetings.all(),
    cost: ctx.manager.cost.summary(),
    hats: listHats(),
    models: ctx.models,
  };
}

function handleCommand(
  ctx: AppContext,
  cmd: ClientCommand,
  reply: (r: ServerReply | ServerEvent) => void,
): void {
  const { manager } = ctx;
  switch (cmd.type) {
    case 'chat': {
      const inst = mustInstance(ctx, cmd.instanceId);
      inst.log('message', `[chat] humano -> ${inst.id}: ${cmd.text}`);
      inst.enqueue(
        `Mensagem direta do humano (responda no seu texto; ele lê seus logs):\n\n${cmd.text}`,
        'Chat com o humano',
      );
      break;
    }
    case 'assign_task': {
      const inst = mustInstance(ctx, cmd.instanceId);
      inst.enqueue(cmd.task, cmd.task.slice(0, 80));
      break;
    }
    case 'respond': {
      const result = manager.bus.tryRespond(cmd.messageId, HUMAN, {
        approved: cmd.approved,
        text: cmd.text,
      });
      if (!result.ok) {
        reply({ type: 'toast', level: 'info', text: result.notice });
      }
      break;
    }
    case 'control': {
      const inst = mustInstance(ctx, cmd.instanceId);
      if (cmd.action === 'pause') inst.pause();
      else if (cmd.action === 'resume') inst.resume();
      else inst.stop();
      break;
    }
    case 'spawn_instance': {
      manager.spawn(cmd.agent);
      break;
    }
    case 'set_hat': {
      const def = manager.defs.get(cmd.agent);
      if (!def) throw new Error(`agente "${cmd.agent}" não existe`);
      const updated = saveAgent({ ...def.config, hat: cmd.hat }, def.instructions, ctx.models);
      manager.defs.set(cmd.agent, updated);
      for (const inst of manager.instances.values()) {
        if (inst.agentName === cmd.agent) {
          inst.hat = cmd.hat;
          inst.persist();
          ctx.hub.broadcast({ type: 'instance_update', instance: inst.toInfo() });
        }
      }
      ctx.hub.broadcast({ type: 'agents_changed', agents: [...manager.defs.values()] });
      break;
    }
    case 'save_agent': {
      const def = saveAgent(cmd.config, cmd.instructions, ctx.models);
      // revalida o conjunto todo (referências cruzadas de can_talk_to etc.)
      manager.defs = loadAgents(ctx.models);
      void def;
      ctx.hub.broadcast({ type: 'agents_changed', agents: [...manager.defs.values()] });
      break;
    }
    case 'delete_agent': {
      const inUse = [...manager.instances.values()].some((i) => i.agentName === cmd.agent);
      if (inUse) throw new Error('encerre e remova as instâncias deste agente antes de excluí-lo');
      deleteAgent(cmd.agent);
      manager.defs = loadAgents(ctx.models);
      ctx.hub.broadcast({ type: 'agents_changed', agents: [...manager.defs.values()] });
      break;
    }
    case 'start_pipeline': {
      ctx.executor.start(cmd.pipeline);
      break;
    }
    case 'pipeline_control': {
      ctx.executor.control(cmd.runId, cmd.action);
      break;
    }
    case 'start_meeting': {
      ctx.meetings.start({
        title: cmd.title,
        agenda: cmd.agenda,
        participants: cmd.participants,
        startedBy: HUMAN,
        maxRounds: cmd.maxRounds,
      });
      break;
    }
    case 'get_logs': {
      reply({
        type: 'logs',
        instanceId: cmd.instanceId,
        entries: getLogs(ctx.db, cmd.instanceId, cmd.beforeId, cmd.limit ?? 200),
      });
      break;
    }
    case 'set_budget': {
      manager.cost.setBudget(cmd.budgetUsd);
      ctx.hub.broadcast({ type: 'cost_update', cost: manager.cost.summary() });
      break;
    }
  }
}

function mustInstance(ctx: AppContext, id: string) {
  const inst = ctx.manager.instances.get(id);
  if (!inst) throw new Error(`instância "${id}" não existe`);
  return inst;
}

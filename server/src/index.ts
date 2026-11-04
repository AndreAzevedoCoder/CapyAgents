import { BUDGET_USD, BUS_TIMEOUT_MS, describeAuth } from './env.js';
import { openDb } from './db/database.js';
import { Hub } from './hub.js';
import { loadAgents, loadModels, AgentValidationError } from './agents/registry.js';
import { RuntimeManager } from './runtime/manager.js';
import { CostTracker } from './cost/cost.js';
import { PipelineExecutor } from './pipelines/executor.js';
import { loadPipelines, PipelineValidationError } from './pipelines/parser.js';
import { MeetingService } from './meetings/meetings.js';
import { ensureWorkspaceRepo } from './pipelines/worktrees.js';
import { startServer } from './ws/server.js';

// O SDK pode lançar erros assíncronos fora do fluxo awaitado (ex. resposta de
// controle depois que o processo do CLI encerrou). O orquestrador não pode
// cair por causa de um turno: registra e segue; o turno afetado erra sozinho.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err instanceof Error ? err.message : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err instanceof Error ? err.message : err);
});

function main(): void {
  console.log(describeAuth());

  const db = openDb();
  const hub = new Hub();
  const models = loadModels();

  let defs;
  let pipelines;
  try {
    defs = loadAgents(models);
    pipelines = loadPipelines();
  } catch (err) {
    if (err instanceof AgentValidationError || err instanceof PipelineValidationError) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // pedidos pendentes de sessões anteriores não podem mais ser resolvidos
  db.prepare("UPDATE messages SET status = 'expired' WHERE status IN ('pending', 'escalated')").run();

  ensureWorkspaceRepo();

  const cost = new CostTracker(db, BUDGET_USD);
  const manager = new RuntimeManager(db, hub, defs, models, cost, BUS_TIMEOUT_MS);
  manager.restore();
  manager.ensureDefaultInstances();

  const executor = new PipelineExecutor(db, hub, manager, pipelines);
  executor.restore();

  const meetings = new MeetingService(db, hub, manager);
  manager.meetings = meetings;

  startServer({ db, hub, manager, executor, meetings, models });

  console.log(
    `${defs.size} agentes, ${manager.instances.size} instâncias, ${pipelines.size} pipelines carregados.`,
  );
}

main();

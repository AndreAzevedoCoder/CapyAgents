import Database from 'better-sqlite3';
import path from 'node:path';
import type {
  BusMessage,
  LogEntry,
  LogKind,
  Meeting,
  MeetingTurn,
  PipelineRun,
  StepRun,
} from '@agent-office/shared';
import { DATA_DIR } from '../env.js';

export type Db = Database.Database;

export function openDb(file?: string): Db {
  const db = new Database(file ?? path.join(DATA_DIR, 'office.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      model TEXT NOT NULL,
      hat TEXT NOT NULL DEFAULT 'none',
      state TEXT NOT NULL DEFAULT 'idle',
      task TEXT,
      workdir TEXT,
      session_id TEXT,
      desk_index INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      data TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_instance ON logs(instance_id, id);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      content TEXT NOT NULL,
      reply_to TEXT,
      tool TEXT,
      tool_input TEXT,
      approved INTEGER,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agenda TEXT NOT NULL,
      participants TEXT NOT NULL,
      started_by TEXT NOT NULL,
      max_rounds INTEGER NOT NULL,
      current_round INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      room_index INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meeting_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      speaker TEXT NOT NULL,
      round INTEGER NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      pipeline TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS step_runs (
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL,
      instance_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      output TEXT,
      artifacts TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER,
      ended_at INTEGER,
      error TEXT,
      PRIMARY KEY (run_id, step_id)
    );
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      run_id TEXT,
      tokens_in INTEGER NOT NULL,
      tokens_out INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function insertLog(
  db: Db,
  instanceId: string,
  kind: LogKind,
  text: string,
  data?: unknown,
): LogEntry {
  const ts = Date.now();
  const serialized = data === undefined ? null : JSON.stringify(data);
  const info = db
    .prepare('INSERT INTO logs (instance_id, kind, text, data, ts) VALUES (?, ?, ?, ?, ?)')
    .run(instanceId, kind, text, serialized, ts);
  return { id: Number(info.lastInsertRowid), instanceId, kind, text, data: serialized, ts };
}

export function getLogs(db: Db, instanceId: string, beforeId?: number, limit = 200): LogEntry[] {
  const rows = beforeId
    ? db
        .prepare(
          'SELECT * FROM logs WHERE instance_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        )
        .all(instanceId, beforeId, limit)
    : db
        .prepare('SELECT * FROM logs WHERE instance_id = ? ORDER BY id DESC LIMIT ?')
        .all(instanceId, limit);
  return (rows as any[])
    .map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      kind: r.kind,
      text: r.text,
      data: r.data,
      ts: r.ts,
    }))
    .reverse();
}

// ---------------------------------------------------------------------------
// Mensagens do barramento
// ---------------------------------------------------------------------------

export function saveMessage(db: Db, m: BusMessage): void {
  db.prepare(
    `INSERT INTO messages (id, type, from_id, to_id, content, reply_to, tool, tool_input, approved, status, created_at, resolved_at)
     VALUES (@id, @type, @from, @to, @content, @replyTo, @tool, @toolInput, @approved, @status, @createdAt, @resolvedAt)
     ON CONFLICT(id) DO UPDATE SET
       to_id = @to, approved = @approved, status = @status, resolved_at = @resolvedAt`,
  ).run({
    ...m,
    toolInput: m.toolInput === null ? null : JSON.stringify(m.toolInput),
    approved: m.approved === null ? null : m.approved ? 1 : 0,
  });
}

export function loadMessages(db: Db, filter?: { status?: string; to?: string }): BusMessage[] {
  let sql = 'SELECT * FROM messages';
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.to) {
    where.push('to_id = ?');
    params.push(filter.to);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at ASC';
  return (db.prepare(sql).all(...params) as any[]).map(rowToMessage);
}

function rowToMessage(r: any): BusMessage {
  return {
    id: r.id,
    type: r.type,
    from: r.from_id,
    to: r.to_id,
    content: r.content,
    replyTo: r.reply_to,
    tool: r.tool,
    toolInput: r.tool_input ? JSON.parse(r.tool_input) : null,
    approved: r.approved === null ? null : r.approved === 1,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

// ---------------------------------------------------------------------------
// Uso de tokens
// ---------------------------------------------------------------------------

export function recordUsage(
  db: Db,
  instanceId: string,
  runId: string | null,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
): void {
  db.prepare(
    'INSERT INTO usage (instance_id, run_id, tokens_in, tokens_out, cost_usd, ts) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(instanceId, runId, tokensIn, tokensOut, costUsd, Date.now());
}

export function usageTotals(db: Db): {
  totalUsd: number;
  byInstance: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }>;
  byPipeline: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }>;
} {
  const byInstance: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }> = {};
  const byPipeline: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }> = {};
  let totalUsd = 0;
  const rows = db
    .prepare(
      'SELECT instance_id, run_id, SUM(tokens_in) ti, SUM(tokens_out) tok, SUM(cost_usd) c FROM usage GROUP BY instance_id, run_id',
    )
    .all() as any[];
  for (const r of rows) {
    totalUsd += r.c;
    const inst = (byInstance[r.instance_id] ??= { tokensIn: 0, tokensOut: 0, costUsd: 0 });
    inst.tokensIn += r.ti;
    inst.tokensOut += r.tok;
    inst.costUsd += r.c;
    if (r.run_id) {
      const run = (byPipeline[r.run_id] ??= { tokensIn: 0, tokensOut: 0, costUsd: 0 });
      run.tokensIn += r.ti;
      run.tokensOut += r.tok;
      run.costUsd += r.c;
    }
  }
  return { totalUsd, byInstance, byPipeline };
}

// ---------------------------------------------------------------------------
// Reuniões
// ---------------------------------------------------------------------------

export function saveMeeting(db: Db, m: Meeting): void {
  db.prepare(
    `INSERT INTO meetings (id, title, agenda, participants, started_by, max_rounds, current_round, status, room_index, summary, created_at, ended_at)
     VALUES (@id, @title, @agenda, @participants, @startedBy, @maxRounds, @currentRound, @status, @roomIndex, @summary, @createdAt, @endedAt)
     ON CONFLICT(id) DO UPDATE SET
       current_round = @currentRound, status = @status, summary = @summary, ended_at = @endedAt`,
  ).run({ ...m, participants: JSON.stringify(m.participants) });
}

export function saveMeetingTurn(db: Db, meetingId: string, turn: MeetingTurn): void {
  db.prepare(
    'INSERT INTO meeting_turns (meeting_id, speaker, round, text, ts) VALUES (?, ?, ?, ?, ?)',
  ).run(meetingId, turn.speaker, turn.round, turn.text, turn.ts);
}

export function loadMeetings(db: Db): Meeting[] {
  const meetings = (db.prepare('SELECT * FROM meetings ORDER BY created_at ASC').all() as any[]).map(
    (r): Meeting => ({
      id: r.id,
      title: r.title,
      agenda: r.agenda,
      participants: JSON.parse(r.participants),
      startedBy: r.started_by,
      maxRounds: r.max_rounds,
      currentRound: r.current_round,
      status: r.status,
      roomIndex: r.room_index,
      transcript: [],
      summary: r.summary,
      createdAt: r.created_at,
      endedAt: r.ended_at,
    }),
  );
  const turns = db.prepare('SELECT * FROM meeting_turns ORDER BY id ASC').all() as any[];
  const byId = new Map(meetings.map((m) => [m.id, m]));
  for (const t of turns) {
    byId.get(t.meeting_id)?.transcript.push({
      speaker: t.speaker,
      text: t.text,
      round: t.round,
      ts: t.ts,
    });
  }
  return meetings;
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export function savePipelineRun(db: Db, run: PipelineRun): void {
  db.prepare(
    `INSERT INTO pipeline_runs (id, pipeline, status, started_at, ended_at)
     VALUES (@id, @pipeline, @status, @startedAt, @endedAt)
     ON CONFLICT(id) DO UPDATE SET status = @status, ended_at = @endedAt`,
  ).run(run);
  const stmt = db.prepare(
    `INSERT INTO step_runs (run_id, step_id, status, instance_id, attempts, output, artifacts, started_at, ended_at, error)
     VALUES (@runId, @stepId, @status, @instanceId, @attempts, @output, @artifacts, @startedAt, @endedAt, @error)
     ON CONFLICT(run_id, step_id) DO UPDATE SET
       status = @status, instance_id = @instanceId, attempts = @attempts, output = @output,
       artifacts = @artifacts, started_at = @startedAt, ended_at = @endedAt, error = @error`,
  );
  for (const s of run.steps) {
    stmt.run({ runId: run.id, ...s, artifacts: JSON.stringify(s.artifacts) });
  }
}

export function loadPipelineRuns(db: Db): PipelineRun[] {
  const runs = (db.prepare('SELECT * FROM pipeline_runs ORDER BY started_at ASC').all() as any[]).map(
    (r): PipelineRun => ({
      id: r.id,
      pipeline: r.pipeline,
      status: r.status,
      steps: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }),
  );
  const byId = new Map(runs.map((r) => [r.id, r]));
  const steps = db.prepare('SELECT * FROM step_runs').all() as any[];
  for (const s of steps) {
    const run = byId.get(s.run_id);
    if (!run) continue;
    run.steps.push({
      stepId: s.step_id,
      status: s.status,
      instanceId: s.instance_id,
      attempts: s.attempts,
      output: s.output,
      artifacts: JSON.parse(s.artifacts),
      startedAt: s.started_at,
      endedAt: s.ended_at,
      error: s.error,
    } satisfies StepRun);
  }
  const totals = usageTotals(db);
  for (const run of runs) {
    const t = totals.byPipeline[run.id];
    if (t) {
      run.tokensIn = t.tokensIn;
      run.tokensOut = t.tokensOut;
      run.costUsd = t.costUsd;
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Instâncias e kv
// ---------------------------------------------------------------------------

export interface InstanceRow {
  id: string;
  agent: string;
  model: string;
  hat: string;
  state: string;
  task: string | null;
  workdir: string | null;
  session_id: string | null;
  desk_index: number;
}

export function saveInstance(db: Db, row: InstanceRow): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO instances (id, agent, model, hat, state, task, workdir, session_id, desk_index, created_at, updated_at)
     VALUES (@id, @agent, @model, @hat, @state, @task, @workdir, @session_id, @desk_index, ${now}, ${now})
     ON CONFLICT(id) DO UPDATE SET
       model = @model, hat = @hat, state = @state, task = @task, workdir = @workdir,
       session_id = @session_id, desk_index = @desk_index, updated_at = ${now}`,
  ).run(row);
}

export function loadInstances(db: Db): InstanceRow[] {
  return db.prepare('SELECT * FROM instances ORDER BY created_at ASC').all() as InstanceRow[];
}

export function deleteInstance(db: Db, id: string): void {
  db.prepare('DELETE FROM instances WHERE id = ?').run(id);
}

export function kvGet(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any;
  return row ? row.value : null;
}

export function kvSet(db: Db, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  else db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
}

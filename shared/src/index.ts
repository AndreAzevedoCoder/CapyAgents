/**
 * Tipos compartilhados entre server e web.
 * O protocolo WebSocket e as entidades do runtime vivem aqui.
 */

// ---------------------------------------------------------------------------
// Agentes
// ---------------------------------------------------------------------------

/** Conteúdo validado de agents/<nome>/agent.json (fonte de verdade de permissões). */
export interface AgentConfig {
  name: string;
  model: string;
  /** Quantas instâncias criar por padrão (dev-1, dev-2, ...). */
  instances: number;
  hat: string;
  tools: { allow: string[]; deny: string[]; deny_commands: string[] };
  paths: { allow: string[]; deny: string[] };
  can_talk_to: string[];
  /** ferramenta -> nome do agente aprovador (ou "human"). */
  requires_approval_from: Record<string, string>;
  /** Limite de turnos por tarefa (proteção contra loops). */
  max_turns: number;
}

/** Definição completa carregada do disco (agent.json + AGENT.md). */
export interface AgentDefinition {
  config: AgentConfig;
  /** Papel e instruções (AGENT.md). Nunca amplia permissões. */
  instructions: string;
}

export const AGENT_STATES = [
  'idle',
  'working',
  'waiting',
  'in_meeting',
  'blocked',
  'paused',
  'done',
  'error',
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Onde a instância está no escritório 3D. */
export type AgentLocation =
  | { kind: 'desk'; deskIndex: number }
  | { kind: 'meeting'; roomIndex: number; seatIndex: number };

export interface InstanceInfo {
  /** ex.: "dev-1". Único no sistema. */
  id: string;
  /** Nome do tipo de agente, ex.: "dev". */
  agent: string;
  model: string;
  hat: string;
  state: AgentState;
  /** Descrição curta da tarefa atual, se houver. */
  task: string | null;
  /** Com quem está interagindo agora (para o 3D destacar), se houver. */
  interactingWith: string | null;
  meetingId: string | null;
  location: AgentLocation;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Mensagens na fila aguardando ponto seguro de entrega. */
  queuedMessages: number;
  /** Diretório de trabalho (worktree) atual, se houver. */
  workdir: string | null;
}

// ---------------------------------------------------------------------------
// Barramento de mensagens
// ---------------------------------------------------------------------------

export type BusMessageType =
  | 'message'
  | 'question'
  | 'permission_request'
  | 'permission_response';

export type BusMessageStatus =
  | 'pending' // aguardando entrega/resposta
  | 'delivered' // entregue; não exige resposta
  | 'answered'
  | 'approved'
  | 'denied'
  | 'escalated' // sem resposta no prazo ou ciclo detectado -> humano
  | 'expired';

export interface BusMessage {
  id: string;
  type: BusMessageType;
  /** id de instância (ex. "dev-1") ou "human". */
  from: string;
  to: string;
  content: string;
  /** id da mensagem que esta responde (question/permission_request). */
  replyTo: string | null;
  /** Para permission_request/response. */
  tool: string | null;
  toolInput: unknown | null;
  approved: boolean | null;
  status: BusMessageStatus;
  createdAt: number;
  resolvedAt: number | null;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export type LogKind =
  | 'thinking' // raciocínio resumido / texto do assistente
  | 'tool' // chamada de ferramenta
  | 'tool_result'
  | 'message' // mensagens de/para o agente
  | 'permission' // decisões do motor de permissões (incl. bloqueios)
  | 'error'
  | 'system';

export interface LogEntry {
  id: number;
  instanceId: string;
  kind: LogKind;
  text: string;
  /** JSON adicional (input da ferramenta, etc.), já serializado. */
  data: string | null;
  ts: number;
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export interface PipelineStepDef {
  id: string;
  /** Nome do tipo de agente (ex. "dev") ou instância exata (ex. "dev-1"). */
  agent: string;
  /** Instrução da etapa. Suporta {{inputs.x}} e {{steps.<id>.output}}. */
  task: string;
  depends_on: string[];
  /** Entradas nomeadas (documentação do grafo). */
  inputs: string[];
  /** Saídas nomeadas (artefatos esperados). */
  outputs: string[];
  /** Exige aprovação humana antes de executar. */
  human_approval: boolean;
  /** Critério de conclusão verificado pelo executor (texto para o agente declarar). */
  done_when: string | null;
  /** Política de retry. */
  retries: number;
  /** Executar em git worktree isolada (tarefas de código). */
  worktree: boolean;
  /** Etapa de merge explícito das worktrees das dependências. */
  merge: boolean;
}

export interface PipelineDef {
  name: string;
  description: string;
  steps: PipelineStepDef[];
}

export type StepRunStatus =
  | 'pending'
  | 'waiting_approval'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

export interface StepRun {
  stepId: string;
  status: StepRunStatus;
  instanceId: string | null;
  attempts: number;
  output: string | null;
  /** Artefatos (caminhos) produzidos. */
  artifacts: string[];
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}

export type PipelineRunStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface PipelineRun {
  id: string;
  pipeline: string;
  status: PipelineRunStatus;
  steps: StepRun[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
}

// ---------------------------------------------------------------------------
// Reuniões
// ---------------------------------------------------------------------------

export type MeetingStatus = 'gathering' | 'in_progress' | 'summarizing' | 'done' | 'cancelled';

export interface MeetingTurn {
  speaker: string;
  text: string;
  round: number;
  ts: number;
}

export interface Meeting {
  id: string;
  title: string;
  agenda: string;
  /** ids de instância; "human" pode participar. */
  participants: string[];
  startedBy: string;
  maxRounds: number;
  currentRound: number;
  status: MeetingStatus;
  roomIndex: number;
  transcript: MeetingTurn[];
  summary: string | null;
  createdAt: number;
  endedAt: number | null;
}

// ---------------------------------------------------------------------------
// Modelos e custo
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  label: string;
  /** USD por milhão de tokens. */
  inputPerMtok: number;
  outputPerMtok: number;
}

export interface CostSummary {
  totalUsd: number;
  budgetUsd: number | null;
  budgetExceeded: boolean;
  byInstance: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }>;
  byPipeline: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }>;
}

// ---------------------------------------------------------------------------
// Chapéus
// ---------------------------------------------------------------------------

export interface HatInfo {
  /** Nome do arquivo sem extensão, ex. "cowboy". */
  id: string;
  file: string;
  /** Ajustes de encaixe na cabeça. */
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
}

// ---------------------------------------------------------------------------
// Protocolo WebSocket
// ---------------------------------------------------------------------------

/** Eventos servidor -> cliente. */
export type ServerEvent =
  | {
      type: 'snapshot';
      agents: AgentDefinition[];
      instances: InstanceInfo[];
      pendingForHuman: BusMessage[];
      pipelines: PipelineDef[];
      runs: PipelineRun[];
      meetings: Meeting[];
      cost: CostSummary;
      hats: HatInfo[];
      models: ModelInfo[];
    }
  | { type: 'instance_update'; instance: InstanceInfo }
  | { type: 'instance_removed'; instanceId: string }
  | { type: 'log'; entry: LogEntry }
  | { type: 'bus_message'; message: BusMessage }
  | { type: 'pipeline_update'; run: PipelineRun }
  | { type: 'meeting_update'; meeting: Meeting }
  | { type: 'cost_update'; cost: CostSummary }
  | { type: 'agents_changed'; agents: AgentDefinition[] }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string };

/** Comandos cliente -> servidor. */
export type ClientCommand =
  | { type: 'chat'; instanceId: string; text: string }
  | { type: 'assign_task'; instanceId: string; task: string }
  | { type: 'respond'; messageId: string; approved?: boolean; text?: string }
  | { type: 'control'; instanceId: string; action: 'pause' | 'resume' | 'stop' }
  | { type: 'spawn_instance'; agent: string }
  | { type: 'set_hat'; agent: string; hat: string }
  | { type: 'save_agent'; config: AgentConfig; instructions: string }
  | { type: 'delete_agent'; agent: string }
  | { type: 'start_pipeline'; pipeline: string }
  | { type: 'pipeline_control'; runId: string; action: 'pause' | 'resume' | 'cancel' }
  | {
      type: 'start_meeting';
      title: string;
      agenda: string;
      participants: string[];
      maxRounds?: number;
    }
  | { type: 'get_logs'; instanceId: string; beforeId?: number; limit?: number }
  | { type: 'set_budget'; budgetUsd: number | null };

/** Respostas pontuais a comandos (ex. get_logs). */
export type ServerReply = { type: 'logs'; instanceId: string; entries: LogEntry[] };

export const HUMAN = 'human';

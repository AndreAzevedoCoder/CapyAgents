import { create } from 'zustand';
import type {
  AgentDefinition,
  BusMessage,
  ClientCommand,
  CostSummary,
  HatInfo,
  InstanceInfo,
  LogEntry,
  Meeting,
  ModelInfo,
  PipelineDef,
  PipelineRun,
  ServerEvent,
  ServerReply,
} from '@agent-office/shared';

export const API_BASE = import.meta.env.DEV ? 'http://127.0.0.1:4777' : '';
const WS_URL = import.meta.env.DEV
  ? 'ws://127.0.0.1:4777'
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

const MAX_LOGS = 500;

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

interface OfficeState {
  connected: boolean;
  agents: AgentDefinition[];
  instances: Record<string, InstanceInfo>;
  pendingForHuman: BusMessage[];
  pipelines: PipelineDef[];
  runs: Record<string, PipelineRun>;
  meetings: Record<string, Meeting>;
  cost: CostSummary | null;
  hats: HatInfo[];
  models: ModelInfo[];
  logs: Record<string, LogEntry[]>;
  selectedId: string | null;
  editorOpen: boolean;
  editorAgent: string | null;
  meetingModalOpen: boolean;
  toasts: Toast[];

  send: (cmd: ClientCommand) => void;
  select: (id: string | null) => void;
  openEditor: (agent: string | null) => void;
  closeEditor: () => void;
  setMeetingModal: (open: boolean) => void;
  dismissToast: (id: number) => void;
}

let socket: WebSocket | null = null;
let toastSeq = 0;

export const useOffice = create<OfficeState>((set, get) => {
  function connect(): void {
    socket = new WebSocket(WS_URL);
    socket.onopen = () => set({ connected: true });
    socket.onclose = () => {
      set({ connected: false });
      setTimeout(connect, 1500);
    };
    socket.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as ServerEvent | ServerReply;
      apply(data);
    };
  }

  function apply(ev: ServerEvent | ServerReply): void {
    switch (ev.type) {
      case 'snapshot':
        set({
          agents: ev.agents,
          instances: Object.fromEntries(ev.instances.map((i) => [i.id, i])),
          pendingForHuman: ev.pendingForHuman,
          pipelines: ev.pipelines,
          runs: Object.fromEntries(ev.runs.map((r) => [r.id, r])),
          meetings: Object.fromEntries(ev.meetings.map((m) => [m.id, m])),
          cost: ev.cost,
          hats: ev.hats,
          models: ev.models,
        });
        break;
      case 'instance_update':
        set((s) => ({ instances: { ...s.instances, [ev.instance.id]: ev.instance } }));
        break;
      case 'instance_removed':
        set((s) => {
          const instances = { ...s.instances };
          delete instances[ev.instanceId];
          return { instances, selectedId: s.selectedId === ev.instanceId ? null : s.selectedId };
        });
        break;
      case 'log':
        set((s) => {
          const list = s.logs[ev.entry.instanceId] ?? [];
          return {
            logs: {
              ...s.logs,
              [ev.entry.instanceId]: [...list.slice(-MAX_LOGS), ev.entry],
            },
          };
        });
        break;
      case 'logs':
        set((s) => {
          const existing = s.logs[ev.instanceId] ?? [];
          const ids = new Set(ev.entries.map((e) => e.id));
          const merged = [...ev.entries, ...existing.filter((e) => !ids.has(e.id))];
          merged.sort((a, b) => a.id - b.id);
          return { logs: { ...s.logs, [ev.instanceId]: merged.slice(-MAX_LOGS) } };
        });
        break;
      case 'bus_message':
        set((s) => {
          const rest = s.pendingForHuman.filter((m) => m.id !== ev.message.id);
          const pending =
            ev.message.to === 'human' &&
            (ev.message.status === 'pending' || ev.message.status === 'escalated')
              ? [...rest, ev.message]
              : rest;
          return { pendingForHuman: pending };
        });
        break;
      case 'pipeline_update':
        set((s) => ({ runs: { ...s.runs, [ev.run.id]: ev.run } }));
        break;
      case 'meeting_update':
        set((s) => ({ meetings: { ...s.meetings, [ev.meeting.id]: ev.meeting } }));
        break;
      case 'cost_update':
        set({ cost: ev.cost });
        break;
      case 'agents_changed':
        set({ agents: ev.agents });
        break;
      case 'toast': {
        const toast: Toast = { id: ++toastSeq, level: ev.level, text: ev.text };
        set((s) => ({ toasts: [...s.toasts, toast] }));
        setTimeout(
          () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== toast.id) })),
          7000,
        );
        break;
      }
    }
  }

  connect();

  return {
    connected: false,
    agents: [],
    instances: {},
    pendingForHuman: [],
    pipelines: [],
    runs: {},
    meetings: {},
    cost: null,
    hats: [],
    models: [],
    logs: {},
    selectedId: null,
    editorOpen: false,
    editorAgent: null,
    meetingModalOpen: false,
    toasts: [],

    send: (cmd) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(cmd));
    },
    select: (id) => {
      set({ selectedId: id });
      if (id && !(get().logs[id]?.length >= 50)) {
        get().send({ type: 'get_logs', instanceId: id });
      }
    },
    openEditor: (agent) => set({ editorOpen: true, editorAgent: agent }),
    closeEditor: () => set({ editorOpen: false, editorAgent: null }),
    setMeetingModal: (open) => set({ meetingModalOpen: open }),
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});

/** Reunião ativa de uma instância, se houver. */
export function activeMeetingOf(
  meetings: Record<string, Meeting>,
  instanceId: string | null,
): Meeting | null {
  if (!instanceId) return null;
  return (
    Object.values(meetings).find(
      (m) =>
        m.participants.includes(instanceId) &&
        (m.status === 'gathering' || m.status === 'in_progress' || m.status === 'summarizing'),
    ) ?? null
  );
}

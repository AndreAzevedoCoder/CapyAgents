import type { AgentState } from '@capyagents/shared';

export const STATE_COLORS: Record<AgentState, string> = {
  idle: '#8ba1b7',
  working: '#e8a13d',
  waiting: '#b07fe0',
  in_meeting: '#4fb6c9',
  blocked: '#e25555',
  paused: '#9aa3ad',
  done: '#6fbf73',
  error: '#e25555',
};

export const STATE_LABELS: Record<AgentState, string> = {
  idle: 'ocioso',
  working: 'trabalhando',
  waiting: 'esperando',
  in_meeting: 'em reunião',
  blocked: 'bloqueado',
  paused: 'pausado',
  done: 'encerrado',
  error: 'erro',
};

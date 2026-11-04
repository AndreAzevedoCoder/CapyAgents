import type { AgentLocation } from '@capyagents/shared';

/** Layout do escritório: mesas em grade à direita, salas de reunião à esquerda. */

export const DESK_COLS = 4;
export const DESK_SPACING_X = 4.2;
export const DESK_SPACING_Z = 4.6;

export interface Spot {
  /** onde o agente fica em pé. */
  stand: [number, number, number];
  /** para onde olha (ângulo Y em radianos). */
  facing: number;
}

export function deskCenter(i: number): [number, number, number] {
  const col = i % DESK_COLS;
  const row = Math.floor(i / DESK_COLS);
  return [(col - (DESK_COLS - 1) / 2) * DESK_SPACING_X + 4, 0, row * DESK_SPACING_Z - 6];
}

/** O agente fica atrás da mesa, olhando para a tela (direção -z). */
export function deskSpot(i: number): Spot {
  const [x, , z] = deskCenter(i);
  return { stand: [x, 0, z + 1.55], facing: Math.PI };
}

export const ROOMS: Array<{ center: [number, number, number] }> = [
  { center: [-9.5, 0, -4.2] },
  { center: [-9.5, 0, 5.2] },
];

export function seatSpot(roomIndex: number, seatIndex: number): Spot {
  const room = ROOMS[roomIndex % ROOMS.length];
  const angle = (seatIndex / 6) * Math.PI * 2 + Math.PI / 6;
  const r = 2.4;
  const x = room.center[0] + Math.cos(angle) * r;
  const z = room.center[2] + Math.sin(angle) * r;
  return { stand: [x, 0, z], facing: Math.atan2(room.center[0] - x, room.center[2] - z) };
}

export function spotFor(location: AgentLocation): Spot {
  return location.kind === 'desk'
    ? deskSpot(location.deskIndex)
    : seatSpot(location.roomIndex, location.seatIndex);
}

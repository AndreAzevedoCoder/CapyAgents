import { useMemo } from 'react';
import * as THREE from 'three';
import type { InstanceInfo } from '@capyagents/shared';
import { DESK_COLS, ROOMS, deskCenter } from './positions';

const WOOD = '#c9a876';
const WOOD_DARK = '#8a6f49';
const WALL = '#e8e2d6';
const HONEY = '#e8a13d';

/** Mesa simples: tampo, pés e uma "tela". Acende mel quando o dono trabalha. */
function Desk({ index, busy }: { index: number; busy: boolean }) {
  const [x, , z] = deskCenter(index);
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.72, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.0, 0.08, 1.0]} />
        <meshStandardMaterial color={WOOD} roughness={0.8} />
      </mesh>
      {[
        [-0.9, -0.42],
        [0.9, -0.42],
        [-0.9, 0.42],
        [0.9, 0.42],
      ].map(([lx, lz], i) => (
        <mesh key={i} position={[lx, 0.34, lz]}>
          <boxGeometry args={[0.08, 0.68, 0.08]} />
          <meshStandardMaterial color={WOOD_DARK} roughness={0.9} />
        </mesh>
      ))}
      {/* laptop voltado para o agente (que fica em +z): base-teclado + tela */}
      <group position={[0, 0.76, -0.02]}>
        {/* base / deck do teclado */}
        <mesh position={[0, 0.02, 0.06]} castShadow>
          <boxGeometry args={[0.72, 0.035, 0.46]} />
          <meshStandardMaterial color="#c3c7cc" metalness={0.5} roughness={0.5} />
        </mesh>
        {/* área do teclado (recuo escuro) */}
        <mesh position={[0, 0.039, 0.07]}>
          <boxGeometry args={[0.6, 0.006, 0.26]} />
          <meshStandardMaterial color="#2b2e33" roughness={0.8} />
        </mesh>
        {/* Trackpad: fica logo acima do plano do teclado (se ficar na mesma
            altura, as duas faces disputam a mesma profundidade e piscam) e usa
            polygonOffset para vencer sempre o tampo em que está encostado. */}
        <mesh position={[0, 0.0445, 0.235]}>
          <boxGeometry args={[0.18, 0.005, 0.09]} />
          <meshStandardMaterial
            color="#9aa0a7"
            roughness={0.6}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
        {/* tela com leve inclinação para trás (dobradiça na borda de trás) */}
        <group position={[0, 0.02, -0.16]} rotation={[-0.32, 0, 0]}>
          <mesh position={[0, 0.23, 0]} castShadow>
            <boxGeometry args={[0.72, 0.46, 0.022]} />
            <meshStandardMaterial color="#c3c7cc" metalness={0.5} roughness={0.5} />
          </mesh>
          {/* painel do display (voltado ao agente) */}
          <mesh position={[0, 0.23, 0.013]}>
            <boxGeometry args={[0.64, 0.39, 0.004]} />
            <meshStandardMaterial
              color={busy ? '#fff3dd' : '#2a3140'}
              emissive={busy ? HONEY : '#0a0d12'}
              emissiveIntensity={busy ? 1.0 : 0.15}
            />
          </mesh>
        </group>
      </group>
      {/* brilho de mel no chão quando está trabalhando */}
      {busy && (
        <mesh position={[0, 0.012, 0.5]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[1.5, 24]} />
          <meshBasicMaterial color={HONEY} transparent opacity={0.16} />
        </mesh>
      )}
    </group>
  );
}

function MeetingRoom({ center, active }: { center: [number, number, number]; active: boolean }) {
  return (
    <group position={center}>
      {/* tapete delimitando a sala */}
      <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[3.6, 36]} />
        <meshStandardMaterial color={active ? '#bfe3ea' : '#d7d2c4'} roughness={1} />
      </mesh>
      {/* mesa redonda */}
      <mesh position={[0, 0.72, 0]} castShadow>
        <cylinderGeometry args={[1.5, 1.5, 0.08, 28]} />
        <meshStandardMaterial color={WOOD} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.36, 0]}>
        <cylinderGeometry args={[0.12, 0.2, 0.72, 12]} />
        <meshStandardMaterial color={WOOD_DARK} />
      </mesh>
    </group>
  );
}

export function Office({ instances }: { instances: InstanceInfo[] }) {
  const busyDesks = useMemo(() => {
    const set = new Set<number>();
    for (const i of instances) {
      if (i.state === 'working' && i.location.kind === 'desk') set.add(i.location.deskIndex);
    }
    return set;
  }, [instances]);

  const activeRooms = useMemo(() => {
    const set = new Set<number>();
    for (const i of instances) {
      if (i.location.kind === 'meeting') set.add(i.location.roomIndex);
    }
    return set;
  }, [instances]);

  const deskCount = Math.max(
    DESK_COLS * 2,
    ...instances.filter((i) => i.location.kind === 'desk').map((i) => (i.location as any).deskIndex + 1),
  );

  return (
    <group>
      {/* piso */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[34, 26]} />
        <meshStandardMaterial color="#efe7d4" roughness={1} />
      </mesh>
      {/* paredes baixas ao fundo */}
      <mesh position={[0, 1.1, -13]} castShadow>
        <boxGeometry args={[34, 2.2, 0.2]} />
        <meshStandardMaterial color={WALL} roughness={1} />
      </mesh>
      <mesh position={[-17, 1.1, 0]} castShadow>
        <boxGeometry args={[0.2, 2.2, 26]} />
        <meshStandardMaterial color={WALL} roughness={1} />
      </mesh>
      {/* divisória leve entre a área de mesas e as salas */}
      <mesh position={[-4.6, 0.7, 0.5]}>
        <boxGeometry args={[0.12, 1.4, 20]} />
        <meshStandardMaterial color="#ddd6c6" transparent opacity={0.65} />
      </mesh>

      {Array.from({ length: deskCount }, (_, i) => (
        <Desk key={i} index={i} busy={busyDesks.has(i)} />
      ))}
      {ROOMS.map((room, i) => (
        <MeetingRoom key={i} center={room.center} active={activeRooms.has(i)} />
      ))}

      {/* algumas plantas para aquecer o ambiente */}
      {[
        [-16, -11.5],
        [16, -11.5],
        [16, 11.5],
        [-16, 11.5],
      ].map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position={[0, 0.25, 0]}>
            <cylinderGeometry args={[0.3, 0.38, 0.5, 10]} />
            <meshStandardMaterial color="#b0653f" />
          </mesh>
          <mesh position={[0, 0.85, 0]}>
            <sphereGeometry args={[0.5, 10, 8]} />
            <meshStandardMaterial color="#5f9e58" roughness={1} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export const HONEY_COLOR = new THREE.Color(HONEY);

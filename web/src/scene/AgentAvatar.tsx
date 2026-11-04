import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, Text, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { HatInfo, InstanceInfo } from '@agent-office/shared';
import { API_BASE } from '../state/store';
import { STATE_COLORS } from '../stateColors';
import { useBearTemplate } from './Bear';
import { spotFor } from './positions';

/** Posições atuais dos avatares (compartilhadas com as linhas de interação). */
export const avatarPositions = new Map<string, THREE.Vector3>();

const WALK_SPEED = 3.2; // unidades/s — reflete eventos reais, nunca é decorativo

function Hat({
  hat,
  headY,
  width,
  forward,
}: {
  hat: HatInfo;
  headY: number;
  width: number;
  forward: number;
}) {
  const gltf = useGLTF(`${API_BASE}/assets/${hat.file}`);
  const cloned = useMemo(() => {
    // clona a hierarquia, mas compartilha geometria e material
    return gltf.scene.clone(true);
  }, [gltf]);
  // chapéus foram modelados para cabeça de raio ~0.5; cobrem a largura da cabeça
  const fit = width * 0.48;
  return (
    <group
      position={[hat.position[0], headY + 0.04 + hat.position[1], forward * 0.65 + hat.position[2]]}
      rotation={hat.rotation as [number, number, number]}
      scale={fit * hat.scale}
    >
      <primitive object={cloned} />
    </group>
  );
}

export function AgentAvatar({
  info,
  hat,
  selected,
  onClick,
}: {
  info: InstanceInfo;
  hat: HatInfo | null;
  selected: boolean;
  onClick: () => void;
}) {
  const bear = useBearTemplate();
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const walking = useRef(false);
  const heading = useRef(0);

  const spot = spotFor(info.location);
  const target = useMemo(
    () => new THREE.Vector3(spot.stand[0], 0, spot.stand[2]),
    [spot.stand[0], spot.stand[2]],
  );

  useFrame((state, dt) => {
    const g = group.current;
    const b = body.current;
    if (!g || !b) return;
    const t = state.clock.elapsedTime;

    // movimento: anda até o alvo definido pelo runtime (mesa ou sala)
    const delta = target.clone().sub(g.position);
    delta.y = 0;
    const dist = delta.length();
    if (dist > 0.08) {
      walking.current = true;
      const step = Math.min(dist, WALK_SPEED * dt);
      g.position.add(delta.normalize().multiplyScalar(step));
      heading.current = Math.atan2(delta.x, delta.z);
    } else {
      walking.current = false;
      heading.current = spot.facing;
    }
    // vira suavemente
    const a = g.rotation.y;
    const diff = Math.atan2(Math.sin(heading.current - a), Math.cos(heading.current - a));
    g.rotation.y = a + diff * Math.min(1, dt * 8);

    avatarPositions.set(info.id, g.position);

    // animação procedural (o GLB não tem esqueleto)
    if (walking.current) {
      b.position.y = Math.abs(Math.sin(t * 9)) * 0.09;
      b.rotation.z = Math.sin(t * 9) * 0.06;
      b.rotation.x = 0.06;
    } else if (info.state === 'working' || info.state === 'in_meeting') {
      // "digitando"/conversando: inclinado, balanço curto e rápido
      b.position.y = Math.sin(t * 7) * 0.015;
      b.rotation.x = 0.1 + Math.sin(t * 7) * 0.02;
      b.rotation.z = 0;
    } else if (info.state === 'waiting') {
      // olhando em volta, esperando resposta
      b.position.y = Math.sin(t * 2) * 0.02;
      b.rotation.x = 0;
      b.rotation.z = 0;
      b.rotation.y = Math.sin(t * 1.6) * 0.35;
      return;
    } else {
      // respiração em idle
      b.position.y = Math.sin(t * 2) * 0.025;
      b.rotation.x = 0;
      b.rotation.z = 0;
    }
    b.rotation.y = 0;
  });

  const color = STATE_COLORS[info.state];
  const dimmed = info.state === 'done' || info.state === 'paused';

  return (
    <group
      ref={group}
      position={spot.stand}
      rotation={[0, spot.facing, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={() => (document.body.style.cursor = 'pointer')}
      onPointerOut={() => (document.body.style.cursor = 'default')}
    >
      <group ref={body}>
        <group position={bear.offset} scale={bear.scale}>
          {bear.meshes.map((m, i) => (
            <mesh key={i} geometry={m.geometry} material={m.material} castShadow />
          ))}
        </group>
        {hat && (
          <Hat hat={hat} headY={bear.headY} width={bear.width} forward={bear.headForward} />
        )}
      </group>

      {/* nome + estado, sempre voltados para a câmera */}
      <Billboard position={[0, bear.headY + 0.78, 0]}>
        <Text
          fontSize={0.26}
          color={dimmed ? '#8b8b86' : '#2a2a26'}
          outlineWidth={0.012}
          outlineColor="#f5f1e6"
          anchorY="bottom"
        >
          {info.id}
        </Text>
        <mesh position={[0, -0.14, 0]}>
          <circleGeometry args={[0.07, 16]} />
          <meshBasicMaterial color={color} />
        </mesh>
        {info.state === 'waiting' && (
          <Text position={[0.22, -0.14, 0]} fontSize={0.2} color="#b07fe0" anchorY="middle">
            ?
          </Text>
        )}
        {info.queuedMessages > 0 && (
          <Text position={[-0.26, -0.14, 0]} fontSize={0.16} color="#6b7686" anchorY="middle">
            {`✉ ${info.queuedMessages}`}
          </Text>
        )}
      </Billboard>

      {/* anel de seleção */}
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.55, 0.68, 28]} />
          <meshBasicMaterial color="#e8a13d" transparent opacity={0.85} />
        </mesh>
      )}
    </group>
  );
}

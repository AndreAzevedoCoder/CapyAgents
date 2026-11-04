import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, Text, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { HatInfo, InstanceInfo } from '@capyagents/shared';
import { API_BASE } from '../state/store';
import { STATE_COLORS, STATE_LABELS } from '../stateColors';
import { useBearTemplate } from './Bear';
import { spotFor } from './positions';

/** Posições atuais dos avatares (compartilhadas com as linhas de interação). */
export const avatarPositions = new Map<string, THREE.Vector3>();

/** Para onde cada avatar está virado (rotação Y), usado pela câmera de foco. */
export const avatarHeadings = new Map<string, number>();

/** Chapéus desenham acima da cena (ordem 5) e abaixo das placas de nome (10+). */
const HAT_RENDER_ORDER = 5;

const WALK_SPEED = 3.2; // unidades/s — reflete eventos reais, nunca é decorativo

/** Distância em que a placa de nome tem escala 1 (vista geral do escritório). */
const NAMETAG_REFERENCE_DISTANCE = 22;

/**
 * Placa de nome/status no estilo Minecraft: painel escuro semitransparente com
 * o nome em branco e o status na cor do estado. Billboard (de frente para a
 * câmera) e desenhada por cima da cena (não fica oculta por mesas/capivaras).
 */
function Nametag({
  id,
  label,
  statusColor,
  queued,
  dimmed,
  y,
}: {
  id: string;
  label: string;
  statusColor: string;
  queued: number;
  dimmed: boolean;
  y: number;
}) {
  const bottom = queued > 0 ? `${label} · ✉${queued}` : label;
  const chars = Math.max(id.length, bottom.length);
  const width = chars * 0.142 + 0.34;

  // tamanho aparente ~constante na tela: encolhe quando a câmera se aproxima
  // (ao focar num agente) e cresce de longe, continuando legível
  const group = useRef<THREE.Group>(null);
  const worldPos = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    const d = camera.position.distanceTo(g.getWorldPosition(worldPos));
    g.scale.setScalar(THREE.MathUtils.clamp(d / NAMETAG_REFERENCE_DISTANCE, 0.3, 1.7));
  });

  return (
    <Billboard ref={group} position={[0, y, 0]}>
      {/* painel escuro translúcido */}
      <mesh renderOrder={10}>
        <planeGeometry args={[width, 0.66]} />
        <meshBasicMaterial
          color="#0b0e15"
          transparent
          opacity={dimmed ? 0.4 : 0.58}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
      <Text
        position={[0, 0.13, 0.01]}
        fontSize={0.26}
        color={dimmed ? '#b7b7b2' : '#ffffff'}
        anchorX="center"
        anchorY="middle"
        renderOrder={11}
        material-depthTest={false}
        material-depthWrite={false}
        material-transparent
      >
        {id}
      </Text>
      <Text
        position={[0, -0.16, 0.01]}
        fontSize={0.17}
        color={statusColor}
        anchorX="center"
        anchorY="middle"
        renderOrder={11}
        material-depthTest={false}
        material-depthWrite={false}
        material-transparent
      >
        {bottom}
      </Text>
    </Billboard>
  );
}

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
    const root = gltf.scene.clone(true);
    // O chapéu tem prioridade de renderização: desenha depois da capivara e
    // sem teste de profundidade, então a cabeça nunca atravessa a copa — é o
    // que permite assentar um chapéu pequeno baixo, encaixado no crânio.
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.renderOrder = HAT_RENDER_ORDER;
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        mat.depthTest = false;
        mat.depthWrite = false;
        mat.needsUpdate = true;
      }
    });
    return root;
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
  // deslocamento de fase por agente, para as animações não ficarem em sincronia
  const phase = useRef(
    [...info.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 628 / 100,
  );

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
    avatarHeadings.set(info.id, g.rotation.y);

    // animação procedural (o GLB não tem esqueleto); fase por agente p/ dessincronizar
    const ph = phase.current;
    if (walking.current) {
      b.position.y = Math.abs(Math.sin(t * 9 + ph)) * 0.12;
      b.rotation.z = Math.sin(t * 9 + ph) * 0.09;
      b.rotation.x = 0.08;
      b.rotation.y = 0;
      b.scale.setScalar(1);
    } else if (info.state === 'working' || info.state === 'in_meeting') {
      // "digitando": bicadas ritmadas para frente, inclinando sobre o laptop
      const k = t * 6.5 + ph;
      const peck = Math.max(0, Math.sin(k)); // 0..1, só a descida
      b.rotation.x = 0.12 + peck * 0.26; // mergulha a cabeça para o teclado
      b.position.y = -peck * 0.06; // afunda um pouco a cada bicada
      b.rotation.z = Math.sin(k * 0.5) * 0.05; // balanço lateral leve
      b.rotation.y = 0;
      b.scale.setScalar(1);
    } else if (info.state === 'waiting') {
      // olhando em volta, impaciente, esperando resposta
      b.position.y = Math.sin(t * 2.2 + ph) * 0.035;
      b.rotation.x = 0;
      b.rotation.z = Math.sin(t * 1.1 + ph) * 0.06;
      b.rotation.y = Math.sin(t * 1.4 + ph) * 0.45;
      b.scale.setScalar(1);
      return;
    } else {
      // respiração em idle: sobe-e-desce amplo + squash/stretch + balanço suave
      const br = Math.sin(t * 1.7 + ph);
      b.position.y = br * 0.06;
      b.scale.y = 1 + br * 0.04;
      b.scale.x = 1 - br * 0.025;
      b.scale.z = 1 - br * 0.025;
      b.rotation.x = 0;
      b.rotation.z = Math.sin(t * 0.9 + ph) * 0.05;
      b.rotation.y = 0;
      return;
    }
    b.scale.setScalar(1);
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

      {/* placa de nome + status no estilo Minecraft: texto claro sobre painel
          escuro translúcido, sempre de frente para a câmera e sempre visível */}
      <Nametag
        id={info.id}
        label={STATE_LABELS[info.state]}
        statusColor={color}
        queued={info.queuedMessages}
        dimmed={dimmed}
        y={bear.headY + 0.62}
      />
      {info.state === 'waiting' && (
        <Billboard position={[0, bear.headY + 1.18, 0]}>
          <Text fontSize={0.34} color="#b07fe0" anchorY="middle" renderOrder={12}>
            ?
          </Text>
        </Billboard>
      )}

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

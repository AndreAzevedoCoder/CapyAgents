import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { InstanceInfo } from '@agent-office/shared';
import { avatarPositions } from './AgentAvatar';

const CORD = new THREE.Color('#b07fe0'); // lilás do estado "waiting"/interação
const PACKET = new THREE.Color('#f0e6ff');
const PACKETS = 4; // bolinhas viajando ao mesmo tempo
const SPEED = 0.55; // voltas por segundo (origem -> destino)
const LINK_Y = 1.45; // altura em que o cordão sai da cabeça

/** Curva em arco entre dois agentes, recalculada a cada frame. */
function curveFor(from: string, to: string, lift: number): THREE.QuadraticBezierCurve3 | null {
  const a = avatarPositions.get(from);
  const b = avatarPositions.get(to);
  if (!a || !b) return null;
  const start = a.clone().setY(LINK_Y);
  const end = b.clone().setY(LINK_Y);
  const mid = start.clone().add(end).multiplyScalar(0.5);
  mid.y = LINK_Y + 0.4 + start.distanceTo(end) * 0.14 + lift;
  return new THREE.QuadraticBezierCurve3(start, mid, end);
}

/**
 * Um cordão grosso de origem -> destino com bolinhas que atravessam a linha
 * indo na direção do destino. Reflete uma interação real (interactingWith).
 */
function InteractionArc({ from, to }: { from: string; to: string }) {
  const tube = useRef<THREE.Mesh>(null);
  const packetsRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tmpGeom = useRef<THREE.TubeGeometry | null>(null);
  // curva mínima de segurança para o primeiro frame (posições podem não existir)
  const fallbackCurve = useMemo(
    () =>
      new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(0, LINK_Y, 0),
        new THREE.Vector3(0, LINK_Y + 0.4, 0),
        new THREE.Vector3(0.01, LINK_Y, 0),
      ),
    [],
  );

  useFrame(({ clock }) => {
    const pulse = Math.sin(clock.elapsedTime * 3) * 0.05;
    const curve = curveFor(from, to, pulse);
    const tubeMesh = tube.current;
    const packs = packetsRef.current;
    if (!curve || !tubeMesh || !packs) {
      if (tubeMesh) tubeMesh.visible = false;
      if (packs) packs.visible = false;
      return;
    }
    tubeMesh.visible = true;
    packs.visible = true;

    // cordão grosso: tubo ao longo da curva
    const geom = new THREE.TubeGeometry(curve, 24, 0.055, 8, false);
    tubeMesh.geometry.dispose();
    tubeMesh.geometry = geom;
    tmpGeom.current = geom;

    // bolinhas atravessando a linha rumo ao destino (t: 0 origem -> 1 destino)
    const base = (clock.elapsedTime * SPEED) % 1;
    for (let i = 0; i < PACKETS; i++) {
      const t = (base + i / PACKETS) % 1;
      const p = curve.getPoint(t);
      dummy.position.copy(p);
      // encolhe perto das pontas para um efeito de "entrada/saída"
      const s = 0.09 * (0.5 + 0.5 * Math.sin(t * Math.PI));
      dummy.scale.setScalar(Math.max(0.03, s));
      dummy.updateMatrix();
      packs.setMatrixAt(i, dummy.matrix);
    }
    packs.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <mesh ref={tube} visible={false}>
        <tubeGeometry args={[curveFor(from, to, 0) ?? fallbackCurve, 24, 0.055, 8, false]} />
        <meshStandardMaterial
          color={CORD}
          transparent
          opacity={0.55}
          emissive={CORD}
          emissiveIntensity={0.35}
        />
      </mesh>
      <instancedMesh ref={packetsRef} args={[undefined, undefined, PACKETS]}>
        <sphereGeometry args={[1, 12, 12]} />
        <meshStandardMaterial color={PACKET} emissive={PACKET} emissiveIntensity={0.8} />
      </instancedMesh>
    </group>
  );
}

export function InteractionLines({ instances }: { instances: InstanceInfo[] }) {
  const pairs = useMemo(
    () =>
      instances
        .filter((i) => i.interactingWith && i.interactingWith !== 'human')
        .map((i) => [i.id, i.interactingWith!] as const),
    [instances],
  );
  return (
    <group>
      {pairs.map(([from, to]) => (
        <InteractionArc key={`${from}->${to}`} from={from} to={to} />
      ))}
    </group>
  );
}

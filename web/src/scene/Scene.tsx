import { Suspense, useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useOffice } from '../state/store';
import { Office } from './Office';
import { AgentAvatar, avatarHeadings, avatarPositions } from './AgentAvatar';
import { InteractionLines } from './InteractionLines';

const DEFAULT_CAMERA: [number, number, number] = [11, 13, 15];
const DEFAULT_TARGET = new THREE.Vector3(0, 0.8, 0);
/** Distância da câmera ao agente em foco e altura do ponto observado. */
const FOCUS_DISTANCE = 5.5;
const FOCUS_HEIGHT = 1.15;
/** Desvio lateral (rad) para um enquadramento de três quartos do rosto. */
const FACE_OFFSET_ANGLE = 0.6;
/** Altura da câmera no foco, relativa à distância horizontal. */
const FACE_ELEVATION = 0.5;

type Controls = { target: THREE.Vector3; update: () => void } | null;

/**
 * Câmera que acompanha a seleção: ao clicar num agente aproxima dele mantendo
 * o ângulo de visão atual, depois o segue se ele caminhar (sem travar a
 * órbita); ao clicar fora, volta suavemente à vista geral do escritório.
 */
function CameraRig() {
  const selectedId = useOffice((s) => s.selectedId);
  const controls = useThree((s) => s.controls) as Controls;
  const camera = useThree((s) => s.camera);

  const moving = useRef(true);
  const focusDir = useRef(new THREE.Vector3());
  const goalPos = useRef(new THREE.Vector3());
  const goalTarget = useRef(new THREE.Vector3());
  const delta = useRef(new THREE.Vector3());

  // a cada mudança de seleção, recalcula de onde a câmera vai observar
  useEffect(() => {
    if (!controls) return;
    moving.current = true;

    // Ao focar num agente, a câmera vai para a FRENTE dele (a direção que ele
    // encara), em três quartos e um pouco acima: assim aparece o rosto, e não
    // as costas. O laptop fica fora da linha de visão pelo desvio lateral.
    const heading = selectedId ? avatarHeadings.get(selectedId) : undefined;
    if (heading !== undefined) {
      const angle = heading + FACE_OFFSET_ANGLE;
      focusDir.current.set(Math.sin(angle), FACE_ELEVATION, Math.cos(angle)).normalize();
      return;
    }

    // sem agente (volta à vista geral): mantém o ângulo em que você estava
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(4, 5, 6);
    dir.normalize();
    if (dir.y < 0.4) {
      dir.y = 0.4; // nunca termina rasante demais
      dir.normalize();
    }
    focusDir.current.copy(dir);
  }, [selectedId, controls, camera]);

  useFrame((_, dt) => {
    if (!controls) return;
    const k = 1 - Math.pow(0.0015, Math.min(dt, 0.1)); // suavização por tempo

    if (selectedId) {
      const pos = avatarPositions.get(selectedId);
      if (!pos) return;
      goalTarget.current.set(pos.x, FOCUS_HEIGHT, pos.z);

      if (moving.current) {
        goalPos.current
          .copy(goalTarget.current)
          .addScaledVector(focusDir.current, FOCUS_DISTANCE);
        camera.position.lerp(goalPos.current, k);
        controls.target.lerp(goalTarget.current, k);
        if (camera.position.distanceTo(goalPos.current) < 0.08) moving.current = false;
      } else {
        // segue o agente transladando câmera e alvo juntos: a órbita que você
        // fizer continua valendo, só o ponto observado acompanha quem anda
        delta.current.copy(goalTarget.current).sub(controls.target).multiplyScalar(k);
        controls.target.add(delta.current);
        camera.position.add(delta.current);
      }
      controls.update();
    } else if (moving.current) {
      goalPos.current.set(...DEFAULT_CAMERA);
      camera.position.lerp(goalPos.current, k);
      controls.target.lerp(DEFAULT_TARGET, k);
      controls.update();
      if (camera.position.distanceTo(goalPos.current) < 0.08) moving.current = false;
    }
  });

  return null;
}

export function Scene() {
  const instanceMap = useOffice((s) => s.instances);
  const instances = Object.values(instanceMap);
  const hats = useOffice((s) => s.hats);
  const selectedId = useOffice((s) => s.selectedId);
  const select = useOffice((s) => s.select);

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: DEFAULT_CAMERA, fov: 42 }}
      onPointerMissed={() => select(null)}
      style={{ position: 'absolute', inset: 0, background: '#dfe8ec' }}
    >
      <hemisphereLight intensity={0.75} color="#fdf6e6" groundColor="#c8bfa8" />
      <directionalLight
        position={[12, 18, 8]}
        intensity={1.4}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-20}
        shadow-camera-right={20}
        shadow-camera-top={20}
        shadow-camera-bottom={-20}
      />
      <fog attach="fog" args={['#dfe8ec', 42, 70]} />

      <Suspense fallback={null}>
        <Office instances={instances} />
        {instances.map((info) => (
          <AgentAvatar
            key={info.id}
            info={info}
            hat={hats.find((h) => h.id === info.hat) ?? null}
            selected={info.id === selectedId}
            onClick={() => select(info.id)}
          />
        ))}
        <InteractionLines instances={instances} />
      </Suspense>

      <CameraRig />

      <OrbitControls
        makeDefault
        target={[0, 0.8, 0]}
        maxPolarAngle={Math.PI / 2.15}
        minDistance={3}
        maxDistance={46}
        // o pan moveria o alvo e brigaria com o acompanhamento do agente
        enablePan={false}
        enableDamping
      />
    </Canvas>
  );
}

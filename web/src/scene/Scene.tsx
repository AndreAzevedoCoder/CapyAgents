import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useOffice } from '../state/store';
import { Office } from './Office';
import { AgentAvatar } from './AgentAvatar';
import { InteractionLines } from './InteractionLines';

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
      camera={{ position: [11, 13, 15], fov: 42 }}
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

      <OrbitControls
        makeDefault
        target={[0, 0.8, 0]}
        maxPolarAngle={Math.PI / 2.15}
        minDistance={5}
        maxDistance={46}
        enableDamping
      />
    </Canvas>
  );
}

import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { API_BASE } from '../state/store';

export const BEAR_URL = `${API_BASE}/assets/bear.glb`;

export interface BearTemplate {
  /** malhas com geometria/material COMPARTILHADOS entre todas as instâncias. */
  meshes: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }>;
  /** escala para normalizar a altura do urso. */
  scale: number;
  /** deslocamento para apoiar os pés no chão e centrar. */
  offset: [number, number, number];
  /** altura do topo da cabeça (depois de escala/offset) para encaixar o chapéu. */
  headY: number;
  /** largura aproximada (para dimensionar o chapéu). */
  width: number;
  /** avanço da cabeça: o modelo é um quadrúpede, a cabeça fica à frente. */
  headForward: number;
}

const TARGET_HEIGHT = 1.5;

/**
 * Carrega o GLB uma única vez e expõe geometria/material compartilhados.
 * O modelo não tem esqueleto nem animações (verificado na inspeção), então
 * toda a animação é procedural no grupo da instância.
 */
export function useBearTemplate(): BearTemplate {
  const gltf = useGLTF(BEAR_URL);
  return useMemo(() => {
    const meshes: BearTemplate['meshes'] = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        meshes.push({
          geometry: mesh.geometry,
          material: mesh.material as THREE.Material,
        });
      }
    });
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = TARGET_HEIGHT / size.y;
    const center = box.getCenter(new THREE.Vector3());
    return {
      meshes,
      scale,
      offset: [-center.x * scale, -box.min.y * scale, -center.z * scale],
      headY: size.y * scale,
      // largura lateral (x) aproxima bem a cabeça; z é o comprimento do corpo
      width: size.x * scale,
      headForward: size.z * scale * 0.3,
    };
  }, [gltf]);
}

useGLTF.preload(BEAR_URL);

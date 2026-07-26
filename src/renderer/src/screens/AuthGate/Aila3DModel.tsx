/* eslint-disable react/no-unknown-property -- React Three Fiber intrinsic props are not DOM attributes. */
import { useGLTF } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import ailaModelUrl from "../../assets/aila.glb?url";

interface AilaAssetProps {
  onReady: () => void;
}

function AilaAsset({ onReady }: AilaAssetProps): React.JSX.Element {
  const { scene } = useGLTF(ailaModelUrl, false, false);
  const { gl } = useThree();
  const model = useMemo(() => scene.clone(true), [scene]);

  useEffect(() => {
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;

      // There is no ground plane on the sign-in surface. Letting this dense
      // mesh cast and receive its own shadow produces shadow-map striping
      // (especially on the white hair and clothing), so keep the character
      // unshadowed and let the material/lighting provide the depth.
      node.castShadow = false;
      node.receiveShadow = false;

      const materials = Array.isArray(node.material)
        ? node.material
        : [node.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;

        // The asset is viewed fairly close to the camera. A softer normal
        // contribution avoids amplifying high-frequency JPEG normal-map
        // detail into visible bands while retaining the model's shape.
        if (material.normalMap) material.normalScale.setScalar(0.35);
        if (material.emissiveMap) material.emissiveIntensity = 0.18;
        material.roughness = Math.max(material.roughness, 0.72);
        material.metalness = Math.min(material.metalness, 0.18);

        const textures = [
          material.map,
          material.normalMap,
          material.metalnessMap,
          material.roughnessMap,
          material.emissiveMap,
        ];
        const anisotropy = gl.capabilities.getMaxAnisotropy();
        for (const texture of textures) {
          if (!texture) continue;
          texture.anisotropy = anisotropy;
          texture.needsUpdate = true;
        }
      }
    });
    onReady();
  }, [gl, model, onReady]);

  return (
    <group>
      <primitive object={model} />
    </group>
  );
}

function webGLAvailable(): boolean {
  if (
    typeof document === "undefined" ||
    typeof window === "undefined" ||
    typeof window.WebGLRenderingContext === "undefined"
  ) {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function AilaFallback(): React.JSX.Element {
  return (
    <div className="aila-3d-fallback" aria-hidden="true">
      <div className="aila-3d-fallback-halo" />
      <div className="aila-3d-fallback-core">A</div>
    </div>
  );
}

export default function Aila3DModel(): React.JSX.Element {
  const [available] = useState(webGLAvailable);
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);

  return (
    <div
      className="aila-3d-model"
      data-testid="aila-3d-model"
      data-renderer={available ? "three-glb" : "fallback"}
      data-model-ready={ready ? "true" : "false"}
      aria-label="艾拉 3D 模型"
    >
      {available ? (
        <>
          <Canvas
            camera={{ position: [0, 0.02, 4.2], fov: 31 }}
            dpr={[1, 1.5]}
            gl={{ alpha: true, antialias: true }}
            onCreated={({ gl }) => {
              gl.outputColorSpace = THREE.SRGBColorSpace;
              // Neutral tone mapping preserves the model's pastel blue/purple
              // accents without clipping them into the white background.
              gl.toneMapping = THREE.NeutralToneMapping;
              gl.toneMappingExposure = 0.84;
            }}
          >
            <ambientLight intensity={0.82} />
            <directionalLight
              position={[-3, 5, 5]}
              intensity={1.45}
              color="#ffffff"
            />
            <pointLight position={[3, 2, 3]} intensity={0.65} color="#b8d9ff" />
            <pointLight
              position={[-2.5, 1, 2]}
              intensity={0.32}
              color="#ffe1f1"
            />
            <Suspense fallback={null}>
              <AilaAsset onReady={handleReady} />
            </Suspense>
          </Canvas>
          {!ready && <AilaFallback />}
        </>
      ) : (
        <AilaFallback />
      )}
    </div>
  );
}

useGLTF.preload(ailaModelUrl, false, false);

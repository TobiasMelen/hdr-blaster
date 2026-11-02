import { useRef, useState, useEffect, useLayoutEffect, useMemo } from "react";
import { Canvas, extend, useFrame, useThree, type Catalogue } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import {
  color,
  mix,
  normalMap,
  normalWorldGeometry,
  output,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  max,
  vec2,
  vec4,
} from "three/tsl";
import { useControls } from "leva";
import WebGPUGrass, { type GrassLook } from "./WebGPUGrass";
import { ISO_OFFSET, ISO_RIGHT, ISO_UP, ISO_VIEW_HEIGHT } from "./iso";
import { noise } from "./tslNoise";
import { raindrops } from "./rain";
import Lasers, { SelectiveBloom } from "./Lasers";
import { ClusteredLighting } from "./lighting/ClusteredLighting";
import { bareGround, pathInset } from "./worldMap";

// Make R3F intrinsic elements resolve to the WebGPU build of three
extend(THREE as unknown as Catalogue);

type ScenePreset = {
  background: string;
  fog?: { color: string; near: number; far: number };
  ambient: { color: string; intensity: number };
  light: {
    position: [number, number, number];
    color: string;
    intensity: number;
  };
  moon?: { position: [number, number, number]; radius: number; color: string };
  grass: GrassLook;
};

const SCENES: Record<string, ScenePreset> = {
  Day: {
    background: "#c2e2ff",
    ambient: { color: "#ffffff", intensity: 0.4 },
    // From the upper left of the iso view, low enough to rake across the
    // path relief and partly behind the grass for the backlit glow
    light: { position: [-10, 7, 1.4], color: "#FFFFCC", intensity: 1 },
    grass: { specular: "#55554a", shininess: 30, tipTint: [1.0, 0.9, 0.6], translucency: 0.35, wetness: 0 },
  },
  Moon: {
    background: "#070b16",
    fog: { color: "#070b16", near: 60, far: 150 },
    ambient: { color: "#7086cc", intensity: 1.4 },
    // Same general direction as the Day sun
    light: { position: [-49, 50, 7], color: "#b4d6c4", intensity: 1.6 },
    moon: { position: [-245, 250, 35], radius: 9, color: "#eef2ff" },
    grass: { specular: "#b8ccc0", shininess: 20, tipTint: [0.75, 0.85, 1.0], translucency: 0, wetness: 1 },
  },
};

function SceneLighting({ preset }: { preset: ScenePreset }) {
  return (
    <>
      <color attach="background" args={[preset.background]} />
      {preset.fog && (
        <fog
          attach="fog"
          args={[preset.fog.color, preset.fog.near, preset.fog.far]}
        />
      )}
      <ambientLight
        color={preset.ambient.color}
        intensity={preset.ambient.intensity}
      />
      <directionalLight
        position={preset.light.position}
        color={preset.light.color}
        intensity={preset.light.intensity}
      />
      {preset.moon && (
        <mesh position={preset.moon.position}>
          <sphereGeometry args={[preset.moon.radius, 32, 16]} />
          <meshBasicMaterial color={preset.moon.color} fog={false} />
        </mesh>
      )}
    </>
  );
}

// Brown Mud 03 by Rob Tuytel, Poly Haven (CC0). Scanned at 1.3 m, drawn
// larger so the cracks read at iso distance
const GRAVEL_TILE = 8;

function loadTiling(url: string, colorSpace: string) {
  const map = new THREE.TextureLoader().load(url);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = colorSpace;
  map.anisotropy = 8;
  return map;
}

// Ground plane that travels with the ball, so the field never ends. Shows
// gravel where the world map has paths
function Ground({ groundRef, follow, lightColor }) {
  const light = useMemo(() => uniform(new THREE.Color()), []);
  const time = useMemo(() => uniform(0), []);
  useEffect(() => {
    light.value.set(lightColor);
  }, [light, lightColor]);

  const material = useMemo(() => {
    const gravelColor = loadTiling(
      "/textures/brown_mud_03_diff_1k.jpg",
      THREE.SRGBColorSpace
    );
    const gravelNormal = loadTiling(
      "/textures/brown_mud_03_nor_gl_1k.jpg",
      THREE.NoColorSpace
    );
    // Packed ambient occlusion, roughness, metalness
    const gravelArm = loadTiling(
      "/textures/brown_mud_03_arm_1k.jpg",
      THREE.NoColorSpace
    );

    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
    const xz = positionWorld.xz;
    // World xz mapped to follow the plane's own uv axes (v runs along -z),
    // so the normal map's tangent frame lines up
    const gravelUv = vec2(xz.x, xz.y.negate()).div(GRAVEL_TILE);
    const bare = bareGround(xz);

    const arm = texture(gravelArm, gravelUv);
    const occlusion = mix(1.0, arm.r, bare);

    // Random dark spots break up the flat dirt: damp blotches around half a
    // metre across, and small specks like pebble shadows
    const blotches = smoothstep(0.55, 0.75, noise(xz.mul(1.4).add(17.0)));
    const specks = smoothstep(0.7, 0.85, noise(xz.mul(9.0)));
    const spots = mix(1.0, 0.5, blotches).mul(mix(1.0, 0.6, specks));

    // Puddles in the middle of paths, ringed by darker wet dirt
    const puddleNoise = noise(xz.mul(0.45).add(vec2(-31.0, 8.0)));
    const deepEnough = smoothstep(0.35, 0.6, pathInset(xz));
    const puddle = smoothstep(0.65, 0.7, puddleNoise).mul(deepEnough);
    const wet = smoothstep(0.56, 0.68, puddleNoise).mul(deepEnough);

    // Broad light and dark patches hide the tiling
    const gravel = texture(gravelColor, gravelUv)
      .rgb.mul(noise(xz.mul(0.15)).mul(0.3).add(0.85))
      .mul(spots)
      .mul(mix(1.0, 0.55, wet));
    // Fake shadow from the grass: the path darkens towards its edges
    const grassShadow = mix(0.2, 1.0, pathInset(xz));
    // Occlusion also goes into the colour at half strength, since ambient
    // light alone (the only light aoNode affects) is too weak to make the
    // cracks read. Puddles are black smooth metal, so only sun glints and
    // the raindrop rings show on them
    const dirt = mix(color("#232712"), gravel.mul(grassShadow), bare).mul(
      mix(1.0, occlusion, 0.5)
    );
    mat.colorNode = mix(dirt, color("#000000"), puddle);
    mat.aoNode = occlusion;
    mat.metalnessNode = puddle;
    mat.roughnessNode = mix(mix(1.0, arm.g, bare), 0.05, max(puddle, wet.mul(0.5)));
    // Raindrop rings catch the moon/sunlight
    mat.emissiveNode = light.mul(raindrops(xz, time).mul(0.45)).mul(puddle);
    // Doubled normal strength so the relief reads from the iso distance;
    // water lies flat
    mat.normalNode = normalMap(
      texture(gravelNormal, gravelUv),
      vec2(bare.mul(2.0).mul(puddle.oneMinus()))
    );
    return mat;
  }, [light, time]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame((state) => {
    time.value = state.clock.elapsedTime;
    groundRef.current?.position.set(follow.x, -0.01, follow.z);
  });

  return (
    <mesh ref={groundRef} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[200, 200]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

function KineticSphere({ onPositionChange }) {
  const meshRef = useRef<THREE.Mesh>(null);

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardNodeMaterial({
      roughness: 0.3,
      metalness: 0.1,
      color: "#F44",
    });
    // Fake ambient occlusion - darken the underside of the ball
    const bottomFactor = smoothstep(-0.5, 0.2, normalWorldGeometry.y);
    mat.outputNode = vec4(output.rgb.mul(mix(0.3, 1.0, bottomFactor)), output.a);
    return mat;
  }, []);
  useEffect(() => () => material.dispose(), [material]);
  const velocity = useRef(new THREE.Vector3());
  const keys = useRef({ w: false, a: false, s: false, d: false });

  useEffect(() => {
    const handleKeyDown = (event) => {
      switch (event.code) {
        case "KeyW":
          keys.current.w = true;
          break;
        case "KeyA":
          keys.current.a = true;
          break;
        case "KeyS":
          keys.current.s = true;
          break;
        case "KeyD":
          keys.current.d = true;
          break;
      }
    };

    const handleKeyUp = (event) => {
      switch (event.code) {
        case "KeyW":
          keys.current.w = false;
          break;
        case "KeyA":
          keys.current.a = false;
          break;
        case "KeyS":
          keys.current.s = false;
          break;
        case "KeyD":
          keys.current.d = false;
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  useFrame((state, delta) => {
    if (!meshRef.current) return;

    const force = new THREE.Vector3();
    const forceStrength = 8; // Reduced for heavier feel

    // Apply forces based on key input, along the screen's ground axes
    const up = (keys.current.w ? 1 : 0) - (keys.current.s ? 1 : 0);
    const right = (keys.current.d ? 1 : 0) - (keys.current.a ? 1 : 0);
    force.x += (ISO_UP[0] * up + ISO_RIGHT[0] * right) * forceStrength;
    force.z += (ISO_UP[1] * up + ISO_RIGHT[1] * right) * forceStrength;

    // Apply physics with more momentum
    velocity.current.add(force.multiplyScalar(delta));
    velocity.current.multiplyScalar(0.98); // Much less friction for longer coasting

    // Update position
    meshRef.current.position.add(
      velocity.current.clone().multiplyScalar(delta)
    );

    // Keep sphere on ground
    meshRef.current.position.y = 1.0; // New sphere radius

    // Rotation based on movement
    const speed = velocity.current.length();
    if (speed > 0.05) {
      const axis = new THREE.Vector3(
        -velocity.current.z,
        0,
        velocity.current.x
      ).normalize();
      meshRef.current.rotateOnAxis(axis, speed * delta * 0.05);
    }

    // Notify parent of position change
    if (onPositionChange) {
      onPositionChange(meshRef.current.position);
    }
  });

  return (
    <mesh ref={meshRef} position={[0, 1.0, 0]}>
      <sphereGeometry args={[1.0, 32, 32]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

// Fixed isometric orthographic camera that glides after the ball
function IsoCamera({ target }: { target: THREE.Vector3 }) {
  const camera = useThree((state) => state.camera);
  const height = useThree((state) => state.size.height);
  const focus = useRef(target.clone());

  useLayoutEffect(() => {
    camera.zoom = height / ISO_VIEW_HEIGHT;
    camera.updateProjectionMatrix();
  }, [camera, height]);

  // Runs before the default frame callbacks, so the grass places its slot
  // grid for this frame's camera rather than last frame's
  useFrame((_, delta) => {
    focus.current.lerp(target, 1 - Math.exp(-delta * 4));
    camera.position.set(...ISO_OFFSET).add(focus.current);
    camera.lookAt(focus.current);
  }, -1);

  return null;
}

export default function App() {
  const [spherePosition, setSpherePosition] = useState(
    new THREE.Vector3(0, 1.0, 0)
  );
  const groundRef = useRef();

  // Project description in Leva
  const { Scene: sceneName } = useControls("Controls", {
    "Controls": {
      value: "WASD: Move ball, Mouse: Shoot",
      editable: false
    },
    Scene: { value: "Moon", options: Object.keys(SCENES) },
  });
  const scene = SCENES[sceneName];

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      {/* flat: no tone mapping, so values above 1 reach HDR displays */}
      <Canvas
        flat
        orthographic
        camera={{ position: ISO_OFFSET, near: 1, far: 200 }}
        style={{
          userSelect: "none",
          WebkitUserSelect: "none",
          touchAction: "none"
        }}
        gl={async ({ canvas }) => {
          const renderer = new THREE.WebGPURenderer({
            canvas: canvas as HTMLCanvasElement,
            antialias: true,
            alpha: false,
            powerPreference: "high-performance",
            // Half-float canvas with extended tone mapping: HDR output on
            // displays and browsers that support it, plain SDR elsewhere
            outputType: THREE.HalfFloatType,
          });
          // Point lights (the laser bolts) only shade the pixels they reach
          renderer.lighting = new ClusteredLighting();
          await renderer.init();
          return renderer;
        }}
      >
        <SceneLighting key={sceneName} preset={scene} />

        <Ground
          groundRef={groundRef}
          follow={spherePosition}
          lightColor={scene.light.color}
        />
        <WebGPUGrass spherePosition={spherePosition} look={scene.grass} sunPosition={scene.light.position} />
        <KineticSphere onPositionChange={setSpherePosition} />
        <Lasers origin={spherePosition} />
        <SelectiveBloom />

        <IsoCamera target={spherePosition} />
      </Canvas>
    </div>
  );
}

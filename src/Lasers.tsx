import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  acesFilmicToneMapping,
  float,
  max,
  mrt,
  output,
  pass,
  renderOutput,
  vec3,
  vec4,
} from "three/tsl";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";

// Bolts fly level at this height, a bit above the ball's centre
const BOLT_HEIGHT = 1.2;
const BOLT_SPEED = 70; // metres per second
const BOLT_LIFE = 0.7; // seconds
const BOLT_LENGTH = 3.4;
const BOLT_RADIUS = 0.035;
const FIRE_INTERVAL = 0.12; // seconds between shots while the button is held

// Enough for every bolt that can be alive at once. Each has its own red
// point light; lights stay in the scene at zero intensity while idle, since
// changing the light count would recompile every lit material
const POOL_SIZE = Math.ceil(BOLT_LIFE / FIRE_INTERVAL) + 1;
const LIGHT_INTENSITY = 25;
const LIGHT_COLOR = "#ff1006";
const LIGHT_RANGE = 9;

type Bolt = {
  mesh: THREE.Mesh;
  light: THREE.PointLight;
  velocity: THREE.Vector3;
  age: number;
};

const yAxis = new THREE.Vector3(0, 1, 0);
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOLT_HEIGHT);
const raycaster = new THREE.Raycaster();
const aimPoint = new THREE.Vector3();

// Red laser bolts fired from the ball towards the mouse while the mouse
// button is held
export default function Lasers({ origin }: { origin: THREE.Vector3 }) {
  const canvas = useThree((state) => state.gl.domElement);
  const firing = useRef(false);
  // Mouse position in normalised device coordinates, tracked here rather
  // than through R3F's pointer so presses aim where they happen
  const pointer = useRef(new THREE.Vector2());
  const cooldown = useRef(0);
  const next = useRef(0);

  const { group, bolts, dispose } = useMemo(() => {
    const geometry = new THREE.CapsuleGeometry(BOLT_RADIUS, BOLT_LENGTH, 4, 8);
    const material = new THREE.MeshBasicNodeMaterial();
    // Over-bright so it stays saturated deep red after tone mapping, and
    // flagged for the selective bloom pass
    material.colorNode = vec3(3.0, 0.08, 0.05);
    material.mrtNode = mrt({ bloomIntensity: float(1.0) });

    const group = new THREE.Group();
    const bolts: Bolt[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_RANGE, 2);
      group.add(mesh, light);
      bolts.push({ mesh, light, velocity: new THREE.Vector3(), age: BOLT_LIFE });
    }
    return {
      group,
      bolts,
      dispose: () => {
        geometry.dispose();
        material.dispose();
      },
    };
  }, []);
  useEffect(() => dispose, [dispose]);

  useEffect(() => {
    const aim = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.current.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
    };
    const start = (event: PointerEvent) => {
      aim(event);
      if (event.button === 0) firing.current = true;
    };
    const stop = () => {
      firing.current = false;
    };
    canvas.addEventListener("pointerdown", start);
    window.addEventListener("pointermove", aim);
    window.addEventListener("pointerup", stop);
    return () => {
      canvas.removeEventListener("pointerdown", start);
      window.removeEventListener("pointermove", aim);
      window.removeEventListener("pointerup", stop);
    };
  }, [canvas]);

  useFrame((state, delta) => {
    cooldown.current = Math.max(cooldown.current - delta, 0);

    if (firing.current && cooldown.current === 0) {
      raycaster.setFromCamera(pointer.current, state.camera);
      if (raycaster.ray.intersectPlane(aimPlane, aimPoint)) {
        const direction = aimPoint.sub(origin).setY(0);
        if (direction.lengthSq() > 1e-4) {
          direction.normalize();
          const bolt = bolts[next.current];
          next.current = (next.current + 1) % bolts.length;
          bolt.age = 0;
          bolt.velocity.copy(direction).multiplyScalar(BOLT_SPEED);
          // Start at the ball's edge, not inside it
          bolt.mesh.position
            .copy(origin)
            .setY(BOLT_HEIGHT)
            .addScaledVector(direction, 1 + BOLT_LENGTH / 2);
          bolt.mesh.quaternion.setFromUnitVectors(yAxis, direction);
          bolt.mesh.visible = true;
          cooldown.current = FIRE_INTERVAL;
        }
      }
    }

    for (const bolt of bolts) {
      if (bolt.age >= BOLT_LIFE) continue;
      bolt.age += delta;
      if (bolt.age >= BOLT_LIFE) {
        bolt.mesh.visible = false;
        bolt.light.intensity = 0;
        continue;
      }
      bolt.mesh.position.addScaledVector(bolt.velocity, delta);
      bolt.light.position.copy(bolt.mesh.position);
      bolt.light.intensity = LIGHT_INTENSITY;
    }
  });

  return <primitive object={group} />;
}

// Takes over rendering: the scene pass also writes a bloom mask, which only
// the bolts' material sets, so only they bloom. Tone mapping is done here:
// ACES Filmic for the normal range, with what lies above 1 added back on top
// so bright highlights reach HDR displays
const HIGHLIGHT_KEEP = 0.6;

export function SelectiveBloom() {
  const renderer = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  const pipeline = useMemo(() => {
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, bloomIntensity: float(0.0) }));
    const color = scenePass.getTextureNode();
    const mask = scenePass.getTextureNode("bloomIntensity").r;
    const glow = bloom(color.mul(mask), 2.0, 0.6, 0.0);
    // Quarter resolution (default half): the glow is soft anyway, and this
    // makes every blur step about 4x cheaper
    glow.setResolutionScale(0.25);
    const hdr = color.add(glow).rgb;
    const filmic = acesFilmicToneMapping(hdr, float(1.0));
    const highlights = max(hdr.sub(1.0), 0.0).mul(HIGHLIGHT_KEEP);

    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = renderOutput(
      vec4(filmic.add(highlights), 1.0),
      THREE.NoToneMapping,
      THREE.SRGBColorSpace
    );
    return pipeline;
  }, [renderer, scene, camera]);
  useEffect(() => () => pipeline.dispose(), [pipeline]);

  useFrame(() => pipeline.render(), 1);

  return null;
}

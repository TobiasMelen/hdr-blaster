import * as THREE from "three/webgpu";
import { Fn, smoothstep, texture } from "three/tsl";
import { noise } from "./tslNoise";

// The world map: authored layout data (paths, and positions of things placed
// in the world) baked into a texture the shaders sample. Centred on the
// origin; outside it the world is plain grass

export const WORLD_SIZE = 512; // metres per side
const MAP_RES = 1024; // texels per side

type Point = [number, number]; // world x, z

export type MapPath = { width: number; points: Point[] };

// Something placed in the world, for whatever gets added next
export type MapFeature = { kind: string; position: Point };

export const PATHS: MapPath[] = [
  // Main path winding east-west past the start
  {
    width: 3,
    points: [
      [-250, -30],
      [-150, 10],
      [-60, -15],
      [0, 6],
      [50, 25],
      [120, -5],
      [250, 20],
    ],
  },
  // Branch from the north joining the main path
  {
    width: 2.4,
    points: [
      [30, 250],
      [10, 140],
      [-5, 60],
      [0, 6],
    ],
  },
  // Loop south of the main path
  {
    width: 2,
    points: [
      [-60, -15],
      [-80, -80],
      [-20, -140],
      [60, -120],
      [120, -5],
    ],
  },
];

export const FEATURES: MapFeature[] = [];

// Points along a Catmull-Rom curve through the path's points, ~1 m apart
function smoothPath(points: Point[]): Point[] {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, 0, z))
  );
  return curve
    .getSpacedPoints(Math.ceil(curve.getLength()))
    .map((p) => [p.x, p.z]);
}

// Dirt coverage per texel in the red channel, and in green how far inside a
// path the texel is (0 at the grass edge, 1 from INSET_DEPTH in); blue and
// alpha are free for more layers
const INSET_DEPTH = 1.8;

function bakeMap(): Uint8Array {
  const data = new Uint8Array(MAP_RES * MAP_RES * 4);
  const texel = WORLD_SIZE / MAP_RES;
  const toTexel = (v: number) => (v + WORLD_SIZE / 2) / texel - 0.5;

  for (const path of PATHS) {
    const half = path.width / 2;
    const soft = 0.75;
    const reach = half + soft;
    const points = smoothPath(path.points);

    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[i + 1];
      const abx = bx - ax;
      const abz = bz - az;
      const abLengthSq = Math.max(abx * abx + abz * abz, 1e-6);

      const x0 = Math.max(0, Math.floor(toTexel(Math.min(ax, bx) - reach)));
      const x1 = Math.min(MAP_RES - 1, Math.ceil(toTexel(Math.max(ax, bx) + reach)));
      const z0 = Math.max(0, Math.floor(toTexel(Math.min(az, bz) - reach)));
      const z1 = Math.min(MAP_RES - 1, Math.ceil(toTexel(Math.max(az, bz) + reach)));

      for (let tz = z0; tz <= z1; tz++) {
        const z = (tz + 0.5) * texel - WORLD_SIZE / 2;
        for (let tx = x0; tx <= x1; tx++) {
          const x = (tx + 0.5) * texel - WORLD_SIZE / 2;
          const t = THREE.MathUtils.clamp(
            ((x - ax) * abx + (z - az) * abz) / abLengthSq,
            0,
            1
          );
          const distance = Math.hypot(x - ax - abx * t, z - az - abz * t);
          const coverage =
            1 - THREE.MathUtils.smoothstep(distance, half - soft, reach);
          const inset = THREE.MathUtils.clamp((half - distance) / INSET_DEPTH, 0, 1);
          const index = (tz * MAP_RES + tx) * 4;
          data[index] = Math.max(data[index], Math.round(coverage * 255));
          data[index + 1] = Math.max(data[index + 1], Math.round(inset * 255));
        }
      }
    }
  }
  return data;
}

const mapData = bakeMap();

export const worldMapTexture = new THREE.DataTexture(
  mapData,
  MAP_RES,
  MAP_RES,
  THREE.RGBAFormat
);
worldMapTexture.magFilter = THREE.LinearFilter;
worldMapTexture.minFilter = THREE.LinearFilter;
worldMapTexture.needsUpdate = true;

// Dirt coverage (0-1) at a world xz position, for game logic
export function dirtAt(x: number, z: number): number {
  const tx = Math.floor((x + WORLD_SIZE / 2) / (WORLD_SIZE / MAP_RES));
  const tz = Math.floor((z + WORLD_SIZE / 2) / (WORLD_SIZE / MAP_RES));
  if (tx < 0 || tz < 0 || tx >= MAP_RES || tz >= MAP_RES) return 0;
  return mapData[(tz * MAP_RES + tx) * 4] / 255;
}

// How bare the ground is at a world xz position: the baked path coverage
// with a noisy edge, shared by the grass and the ground so they line up
const pathEdgeNoise = (xz: THREE.Node<"vec2">) => noise(xz.mul(0.9)).sub(0.5);

export const bareGround = Fn(([xz]: [THREE.Node<"vec2">]) => {
  const coverage = texture(worldMapTexture, xz.div(WORLD_SIZE).add(0.5)).level(0).r;
  return smoothstep(0.3, 0.7, coverage.add(pathEdgeNoise(xz).mul(0.5)));
});

// How far inside a path a position is (0 at the grass edge, 1 well inside),
// with the same noisy edge as bareGround
export const pathInset = Fn(([xz]: [THREE.Node<"vec2">]) => {
  const inset = texture(worldMapTexture, xz.div(WORLD_SIZE).add(0.5)).level(0).g;
  return smoothstep(0.0, 1.0, inset.add(pathEdgeNoise(xz).mul(0.4)));
});

import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  clamp,
  dot,
  float,
  floor,
  fract,
  instanceIndex,
  mix,
  normalize,
  select,
  smoothstep,
  texture,
  textureStore,
  uniform,
  uvec2,
  vec2,
  vec4,
} from "three/tsl";
import { hash12, hash22, noise } from "./tslNoise";

// The paths: an endless network worked out from the world position. One
// random point per ROAD_CELL square; the borders between the areas nearest
// each point are the paths, meeting at junctions. The world is warped
// first so they wind, and each stretch between two points gets its own
// width, or none (a gap). Worked out by a compute pass into a map of
// MAP_SIZE around the player, which the grass and the ground read, and
// again only once the player strays RECENTRE from its middle

const ROAD_CELL = 70; // metres
const WARP = 14; // metres the world is pushed around by, so paths wind
const WARP_SCALE = 1 / 60; // per metre, how quickly that changes
const WIDTH: [number, number] = [2.6, 4]; // metres, random between
const GAP_CHANCE = 0.2;
// Soft edge either side of the border (metres), and how far in a path's
// middle starts (0 at the grass edge, 1 from INSET_DEPTH in)
const SOFT = 0.75;
const INSET_DEPTH = 1.8;
const MAP_SIZE = 128; // metres per side, enough for the view and RECENTRE
const MAP_RES = 512; // texels per side
const RECENTRE = 16; // metres

// Distance (metres) from a world xz position to the nearest path's middle,
// in x, and that path's half width in y. One pass over the 3x3 cells
// around it finds the two nearest points; the path is the border between
// them. Points keep within their cells' middle 80%, so 3x3 is enough
const nearestPath = Fn(([xz]: [THREE.Node<"vec2">]) => {
  const warp = vec2(noise(xz.mul(WARP_SCALE)), noise(xz.mul(WARP_SCALE).add(41.3))).sub(0.5).mul(WARP * 2);
  const p = xz.add(warp).div(ROAD_CELL);
  const cell = floor(p);
  const local = fract(p);

  // Offset to each point, its cell's, and its squared distance
  const first = vec4(0.0, 0.0, 0.0, 0.0).toVar();
  const second = vec4(0.0, 0.0, 0.0, 0.0).toVar();
  const firstSq = float(8.0).toVar();
  const secondSq = float(8.0).toVar();
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      const offset = vec2(x, y);
      const toPoint = offset.add(hash22(cell.add(offset)).mul(0.8).add(0.1)).sub(local);
      const distanceSq = dot(toPoint, toPoint);
      If(distanceSq.lessThan(firstSq), () => {
        second.assign(first);
        secondSq.assign(firstSq);
        first.assign(vec4(toPoint, offset));
        firstSq.assign(distanceSq);
      }).ElseIf(distanceSq.lessThan(secondSq), () => {
        second.assign(vec4(toPoint, offset));
        secondSq.assign(distanceSq);
      });
    }
  }

  const border = dot(first.xy.add(second.xy).mul(0.5), normalize(second.xy.sub(first.xy)));
  // The same for both cells of the stretch, whichever is nearer. A gap's
  // width is below zero, so even its soft edge misses
  const stretch = hash12(cell.mul(2.0).add(first.zw).add(second.zw).add(0.5));
  const half = select(stretch.lessThan(GAP_CHANCE), -2 * SOFT, mix(WIDTH[0] / 2, WIDTH[1] / 2, fract(stretch.mul(7.0))));
  return vec2(border.mul(ROAD_CELL), half);
});

// Coverage (0 to 1, how much of a texel is path) in red, and how far
// inside a path in green
const map = new THREE.StorageTexture(MAP_RES, MAP_RES);
map.minFilter = map.magFilter = THREE.LinearFilter;
const centre = uniform(new THREE.Vector2(Infinity, Infinity));
const fill = Fn(() => {
  const texel = uvec2(instanceIndex.mod(MAP_RES), instanceIndex.div(MAP_RES));
  const xz = vec2(texel).add(0.5).mul(MAP_SIZE / MAP_RES).sub(MAP_SIZE / 2).add(centre);
  const path = nearestPath(xz);
  const coverage = smoothstep(path.y.sub(SOFT), path.y.add(SOFT), path.x).oneMinus();
  const inset = clamp(path.y.sub(path.x).div(INSET_DEPTH), 0.0, 1.0);
  textureStore(map, texel, vec4(coverage, inset, 0.0, 1.0));
})().compute(MAP_RES * MAP_RES);

// Redraws the map around a position once it's strayed far enough, on a
// whole texel so the paths don't shift
export function updatePaths(renderer: THREE.WebGPURenderer, position: THREE.Vector3) {
  if (Math.hypot(position.x - centre.value.x, position.z - centre.value.y) < RECENTRE) return;
  const texel = MAP_SIZE / MAP_RES;
  centre.value.set(Math.round(position.x / texel) * texel, Math.round(position.z / texel) * texel);
  renderer.compute(fill);
}

const pathEdgeNoise = (xz: THREE.Node<"vec2">) => noise(xz.mul(0.9)).sub(0.5);

// At a world xz position: how bare the ground is in x, and how far inside
// a path in y (0 at the grass edge, 1 well inside). Both with a noisy edge,
// shared by the grass and the ground so they line up
export const paths = Fn(([xz]: [THREE.Node<"vec2">]) => {
  const path = texture(map, xz.sub(centre).div(MAP_SIZE).add(0.5)).level(float(0));
  const edge = pathEdgeNoise(xz);
  return vec2(smoothstep(0.3, 0.7, path.r.add(edge.mul(0.5))), smoothstep(0.0, 1.0, path.g.add(edge.mul(0.4))));
});

import * as THREE from "three/webgpu";

// Blood splats left on the grass where enemies die, which the grass shader
// tints dark red, thrown out the way the killing bolt was going. A ring of
// the most recent ones: the oldest is reused

export const MAX_STAINS = 12;
// Where unused stains sit, far from any grass
const NOWHERE = 1e6;

// Scale of the spray: its cone reaches about three of these
const RADIUS: [number, number] = [1.3, 2.0]; // metres, random between

export class Stains {
  // Each spot: world x, z, radius and the angle it was thrown towards
  // (atan2 of the direction's z and x), which also seeds its shape
  readonly spots = Array.from(
    { length: MAX_STAINS },
    () => new THREE.Vector4(NOWHERE, NOWHERE, 0, 0)
  );
  private next = 0;

  add(x: number, z: number, direction: THREE.Vector3) {
    const radius = THREE.MathUtils.randFloat(...RADIUS);
    this.spots[this.next].set(x, z, radius, Math.atan2(direction.z, direction.x));
    this.next = (this.next + 1) % MAX_STAINS;
  }
}

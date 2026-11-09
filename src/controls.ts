import * as THREE from "three/webgpu";
import { ISO_RIGHT, ISO_UP } from "./iso";
import { createStick } from "./sticks";

// Everything the player steers with, read once a frame into the same three
// things whatever the device: a direction to move along the ground (up to
// 1 long, shorter for a stick pushed part way), a point to aim at, and
// whether to fire. From WASD and the mouse, or on touch screens the Move
// and Blast sticks (see index.html)

// Where a pushed Blast stick aims: this far out along it (metres)
const STICK_REACH = 10;

const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0));

// A direction along the screen's ground axes, from its right and up parts
const alongScreen = (right: number, up: number, out: THREE.Vector3) =>
  out.set(ISO_RIGHT[0] * right + ISO_UP[0] * up, 0, ISO_RIGHT[1] * right + ISO_UP[1] * up);

export type Controls = ReturnType<typeof createControls>;

export function createControls(canvas: HTMLCanvasElement) {
  const moveStick = createStick(document.getElementById("move")!);
  const blastStick = createStick(document.getElementById("blast")!);
  const keys = new Set<string>();
  // In normalised device coordinates, once the mouse has moved
  const pointer = new THREE.Vector2();
  let mouse = false;
  let mouseDown = false;

  addEventListener("keydown", (event) => keys.add(event.code));
  addEventListener("keyup", (event) => keys.delete(event.code));
  const point = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    mouse = true;
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
  };
  addEventListener("pointermove", point);
  canvas.addEventListener("pointerdown", (event) => {
    point(event);
    if (event.pointerType === "mouse" && event.button === 0) mouseDown = true;
  });
  addEventListener("pointerup", () => (mouseDown = false));

  const controls = {
    move: new THREE.Vector3(),
    // Valid while aiming: nothing to aim at before the mouse first moves
    target: new THREE.Vector3(),
    aiming: false,
    firing: false,
    // From around a ground position, aiming level at a height
    read(camera: THREE.Camera, from: THREE.Vector3, height: number) {
      const keyed = (plus: string, minus: string) => +keys.has(plus) - +keys.has(minus);
      alongScreen(keyed("KeyD", "KeyA") + moveStick.value.x, keyed("KeyW", "KeyS") + moveStick.value.y, controls.move);
      if (controls.move.lengthSq() > 1) controls.move.normalize();

      const steer = blastStick.value;
      if (steer.lengthSq() > 0) {
        alongScreen(steer.x, steer.y, controls.target).setLength(STICK_REACH).add(from).setY(height);
        controls.aiming = true;
      } else if (mouse) {
        aimPlane.constant = -height;
        raycaster.setFromCamera(pointer, camera);
        controls.aiming = raycaster.ray.intersectPlane(aimPlane, controls.target) !== null;
      } else {
        controls.aiming = false;
      }
      controls.firing = mouseDown || blastStick.held;
    },
  };
  return controls;
}

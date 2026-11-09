import * as THREE from "three/webgpu";

// An on-screen stick for touch screens: a drag from its middle reads as a
// direction, full length at its rim, x right and y up, while it's held.
// Nudged less than DEAD_ZONE of the way out it reads as zero
const DEAD_ZONE = 0.2;

export type Stick = { readonly value: THREE.Vector2; readonly held: boolean };

export function createStick(element: HTMLElement): Stick {
  const value = new THREE.Vector2();
  const knob = element.querySelector<HTMLElement>(".knob")!;
  let held = false;
  const drag = (event: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    const radius = rect.width / 2;
    value.set(event.clientX - rect.left - radius, rect.top + radius - event.clientY).divideScalar(radius);
    if (value.lengthSq() > 1) value.normalize();
    knob.style.transform = `translate(${value.x * radius}px, ${-value.y * radius}px)`;
    if (value.length() < DEAD_ZONE) value.set(0, 0);
  };
  const release = () => {
    held = false;
    value.set(0, 0);
    knob.style.transform = "";
  };
  element.addEventListener("pointerdown", (event) => {
    element.setPointerCapture(event.pointerId);
    held = true;
    drag(event);
  });
  element.addEventListener("pointermove", (event) => held && drag(event));
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);
  return {
    value,
    get held() {
      return held;
    },
  };
}

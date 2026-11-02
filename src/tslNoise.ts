import * as THREE from "three/webgpu";
import { Fn, vec2, vec3, fract, floor, dot, mix } from "three/tsl";

// Hash functions for pseudo-random numbers
export const hash12 = Fn(([p]: [THREE.Node<"vec2">]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

export const hash22 = Fn(([p]: [THREE.Node<"vec2">]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

// Simple value noise
export const noise = Fn(([p]: [THREE.Node<"vec2">]) => {
  const i = floor(p);
  const f = fract(p);
  const a = hash12(i);
  const b = hash12(i.add(vec2(1.0, 0.0)));
  const c = hash12(i.add(vec2(0.0, 1.0)));
  const d = hash12(i.add(vec2(1.0, 1.0)));
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
  return mix(a, b, u.x)
    .add(c.sub(a).mul(u.y).mul(u.x.oneMinus()))
    .add(d.sub(b).mul(u.x).mul(u.y));
});

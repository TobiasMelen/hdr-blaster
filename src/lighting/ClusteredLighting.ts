import * as THREE from "three/webgpu";
import ClusteredLightsNode from "./ClusteredLightsNode.js";

// Forward+ clustered shading: a compute pass sorts point lights into screen
// tiles x depth slices, so each pixel only shades the lights that reach it.
// Same as three's ClusteredLighting addon, using the orthographic-aware node
export class ClusteredLighting extends THREE.Lighting {
  createNode(lights: THREE.Light[] = []) {
    // Most lights, tile size in pixels, depth slices, most lights per cluster
    return new ClusteredLightsNode(32, 32, 24, 16).setLights(lights);
  }
}

import * as THREE from "three/webgpu";
import ClusteredLightsNode from "./ClusteredLightsNode.js";

// Forward+ clustered shading: a compute pass sorts point lights into screen
// tiles x depth slices, so each pixel only shades the lights that reach it.
// Same as three's ClusteredLighting addon, using the orthographic-aware node
export class ClusteredLighting extends THREE.Lighting {
  constructor(
    private maxLights = 32,
    private tileSize = 32,
    private zSlices = 24,
    private maxLightsPerCluster = 16
  ) {
    super();
  }

  createNode(lights: THREE.Light[] = []) {
    return new ClusteredLightsNode(
      this.maxLights,
      this.tileSize,
      this.zSlices,
      this.maxLightsPerCluster
    ).setLights(lights);
  }
}

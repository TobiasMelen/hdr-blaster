import { LightsNode } from "three/webgpu";

export default class ClusteredLightsNode extends LightsNode {
  constructor(
    maxLights?: number,
    tileSize?: number,
    zSlices?: number,
    maxLightsPerCluster?: number
  );
}

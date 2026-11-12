import { SkyBox } from "@cesium/engine";

export function createStarSkyBox(): SkyBox {
  return new SkyBox({
    sources: {
      positiveX: "/skybox/positive-x.png",
      negativeX: "/skybox/negative-x.png",
      positiveY: "/skybox/positive-y.png",
      negativeY: "/skybox/negative-y.png",
      positiveZ: "/skybox/positive-z.png",
      negativeZ: "/skybox/negative-z.png",
    },
  });
}

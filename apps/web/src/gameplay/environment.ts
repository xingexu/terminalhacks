import { EquirectangularReflectionMapping, MeshStandardMaterial, RepeatWrapping, Scene, SRGBColorSpace, Texture, TextureLoader } from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

export function loadEnvironment(scene: Scene, surface: MeshStandardMaterial, repeat: [number, number], onReady: (ready: boolean) => void) {
  let active = true;
  const textures: Texture[] = [];
  const retain = (texture: Texture) => {
    if (!active) { texture.dispose(); return false; }
    textures.push(texture);
    return true;
  };
  const ready = Promise.all([
    new HDRLoader().loadAsync('/environment/sky.hdr').then(texture => {
      if (!retain(texture)) return;
      texture.mapping = EquirectangularReflectionMapping;
      scene.environment = texture;
      scene.environmentIntensity = 0.5;
    }),
    ...(['color', 'normal', 'roughness'] as const).map(async kind => {
      const texture = await new TextureLoader().loadAsync('/environment/concrete-' + kind + '.jpg');
      if (!retain(texture)) return;
      texture.wrapS = texture.wrapT = RepeatWrapping;
      texture.repeat.set(...repeat);
      texture.anisotropy = 4;
      if (kind === 'color') { texture.colorSpace = SRGBColorSpace; surface.map = texture; }
      if (kind === 'normal') surface.normalMap = texture;
      if (kind === 'roughness') surface.roughnessMap = texture;
      surface.needsUpdate = true;
    })
  ]);
  void ready.then(() => { if (active) onReady(true); }, () => { if (active) onReady(false); });
  return () => { active = false; scene.environment = null; textures.forEach(texture => texture.dispose()); };
}

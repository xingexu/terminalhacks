export type Position = [number, number, number];
export type Context = { projectId: string; eventId: string; revision: number; policyVersion: number; sourceIds: string[]; inputHash: string };
export type SceneManifest = {
  id: string; planId: string; revision: number; format: 'glb' | 'original_trail';
  assetId: string; collisionAssetId: string; units: 'm'; coordinateSystem: 'right-handed-y-up';
  scaleConfidence: number | null; boundsMin: Position; boundsMax: Position; spawn: Position;
  anchors: { id: string; position: Position; sourceIds: string[] }[];
  capability: 'free_roam'; provenance: 'imagined' | 'reconstructed';
};
export type Keyframe = { t: number; position: Position; quaternion: [number, number, number, number]; fov: number };
export type CameraPath = { id: string; sceneId: string; revision: number; provenance: 'imagined' | 'reconstructed'; keyframes: Keyframe[] };
export type PathExport = { version: '3.1-proposal'; context: Context; sceneManifest: SceneManifest; cameraPath: CameraPath };

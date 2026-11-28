import { digest, eventById, mediaById, requireCondition as check } from './memory.mjs';

// Version 1 is the private owner-only authorization policy. No cross-user delivery.
export function sceneContext(state, projectId, eventId, requestedIds, worldId) {
  const event = eventById(state, eventId);
  check(event, 404, 'SCENE_UNAVAILABLE', 'This memory is unavailable.');
  const world = worldId && state.worlds?.find(item => item.id === worldId && item.eventId === eventId);
  if (worldId) check(world?.approved && !world.revoked && state.session.lens === 'all' &&
    world.sourceIds.every(id => mediaById(state, id) && event.sourceIds.includes(id)),
  404, 'SCENE_UNAVAILABLE', 'This reconstruction is unavailable.');
  const sourceIds = [...new Set(world ? world.sourceIds : requestedIds)].sort();
  check(sourceIds.length > 0 && sourceIds.length <= 256 && sourceIds.every(id => {
    const source = mediaById(state, id);
    return event.sourceIds.includes(id) && source && !source.pending &&
      (state.session.lens === 'all' || source.provenance === 'original');
  }), 404, 'SCENE_UNAVAILABLE', 'These scene sources are unavailable.');
  return { projectId, eventId, revision: state.revision, policyVersion: 1, sourceIds,
    inputHash: digest({ event, sources: sourceIds.map(id => mediaById(state, id)), world: world || null }) };
}

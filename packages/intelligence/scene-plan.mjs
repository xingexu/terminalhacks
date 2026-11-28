import { digest, generationDependencies, requireCondition as check, uid } from '../runtime/memory.mjs';

export const environments = ['mountain', 'coast', 'forest', 'urban', 'open'];
export const seasons = ['green', 'snow', 'autumn'];

export function evidenceFor(state, eventId) {
  const input = generationDependencies(state, eventId);
  check(input, 404, 'EVENT_NOT_FOUND', 'Select a memory first.');
  const inputHash = digest(input);
  const photoLocations = input.media.filter(item => item.gps).map(item => ({ sourceId: item.id, coordinates: item.gps }));
  const research = state.locationResearch?.[eventId];
  const context = research?.inputHash === inputHash ? research : null;
  const conversation = [input.story, ...input.recollections.map(item => item.text)].filter(Boolean).join('\n');
  const ownText = [input.title, input.placeLabel, conversation].join(' ').toLowerCase();
  const webText = context?.articles.map(item => item.title + ' ' + item.extract).join(' ').toLowerCase() || '';
  const classify = value => /\b(ski|snow|mountain|alps|dolomite|ridge|summit)\w*\b/.test(value) ? 'mountain' :
    /\b(beach|coast|ocean|lake|shore|sea)\w*\b/.test(value) ? 'coast' :
    /\b(forest|woodland|woods|camping)\w*\b/.test(value) ? 'forest' :
    /\b(city|urban|street|downtown|building)\w*\b/.test(value) ? 'urban' : null;
  const environment = classify(ownText) || classify(webText) || 'open';
  const season = /\b(snow|ski|winter)\w*\b/.test(ownText) ? 'snow' : /\b(autumn|fall)\b/.test(ownText) ? 'autumn' : 'green';
  const unknowns = ['Geometry, distances and the walking route are imagined, not measured.',
    'Internet context describes a place; it does not prove what happened there on your date.'];
  if (!input.media.some(item => item.capturedAt)) unknowns.push('No photo or clip has a timestamp with a known timezone.');
  if (!input.gps && !photoLocations.length) unknowns.push('No coordinates are available; confirm the named place before research.');
  const gps = input.gps || photoLocations[0]?.coordinates || null;
  if (gps && photoLocations.some(item => Math.abs(item.coordinates[0] - gps[0]) > 0.02 || Math.abs(item.coordinates[1] - gps[1]) > 0.02)) {
    unknowns.push('Source locations differ. This may include several places; review the selected memory.');
  }
  return { ...input, inputHash, photoLocations, research: context, unknowns,
    suggestion: { environment, season, basis: classify(ownText) ? 'Memory description and recollection' : classify(webText) ? 'Unverified place context' : 'Neutral starting scene' },
    lookup: { query: (input.placeLabel !== 'Unknown location' ? input.placeLabel : '').slice(0, 300),
      coordinates: gps?.map(value => Number(value.toFixed(2))) || null } };
}

export function voiceEvidence(evidence) {
  const rounded = gps => gps?.map(value => Number(value.toFixed(2))) || null;
  return { ...evidence, gps: rounded(evidence.gps),
    media: evidence.media.map(item => ({ ...item, gps: rounded(item.gps) })),
    photoLocations: evidence.photoLocations.map(item => ({ ...item, coordinates: rounded(item.coordinates) })) };
}

export function handoffPlan(plan) {
  const { evidence, ...configuration } = plan;
  return { ...configuration, evidenceSummary: { mediaCount: evidence.media.length, recollectionCount: evidence.recollections.length,
    unknowns: evidence.unknowns, sources: (evidence.research?.articles || []).map(({ title, url, provenance }) => ({ title, url, provenance })) } };
}

export async function lookupPlace(evidence, fetcher = fetch) {
  const { query, coordinates } = evidence.lookup;
  check(coordinates || query.trim(), 400, 'LOCATION_REQUIRED', 'Add a place name or coordinates before researching.');
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({ action: 'query', format: 'json', prop: 'extracts|info', exintro: '1',
    explaintext: '1', exchars: '600', inprop: 'url',
    ...(coordinates ? { generator: 'geosearch', ggscoord: coordinates.join('|'), ggsradius: '10000', ggslimit: '3' } :
      { generator: 'search', gsrsearch: query, gsrlimit: '3' }) });
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(7000), redirect: 'error',
      headers: { 'User-Agent': 'Everwhere/0.1 (hackathon location context; https://github.com/xingexu/terminalhacks)' } });
    if (!response.ok) throw new Error('lookup');
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256_000) throw new Error('large response');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.error) throw new Error('lookup');
    const articles = Object.values(data.query?.pages || {}).slice(0, 3).flatMap(page => {
      if (!Number.isSafeInteger(page.pageid) || typeof page.title !== 'string' || typeof page.extract !== 'string') return [];
      return [{ title: page.title.slice(0, 200), extract: page.extract.slice(0, 600),
        url: 'https://en.wikipedia.org/?curid=' + page.pageid, provenance: 'web_context' }];
    });
    return { inputHash: evidence.inputHash, lookup: evidence.lookup, fetchedAt: new Date().toISOString(),
      provider: 'Wikipedia', articles, attribution: 'Wikipedia contributors, CC BY-SA; follow each source for history and attribution.' };
  } catch {
    check(false, 502, 'CONTEXT_UNAVAILABLE', 'Place research is unavailable. Retry, or continue with your own recollection.');
  }
}

export function previewWorld(state, { eventId, expectedRevision, environment, season }, actor) {
  check(expectedRevision === state.revision, 409, 'REVISION_CONFLICT', 'The memory changed. Review the latest evidence first.');
  check(environments.includes(environment) && seasons.includes(season), 400, 'INVALID_SCENE', 'Choose a supported environment and season.');
  const evidence = evidenceFor(state, eventId);
  const sourceIds = evidence.media.filter(item => item.provenance === 'original' && item.mime.startsWith('image/'))
    .sort((a, b) => (a.capturedAt ? Date.parse(a.capturedAt) : Infinity) - (b.capturedAt ? Date.parse(b.capturedAt) : Infinity))
    .map(item => item.id).slice(0, 6);
  check(sourceIds.length, 400, 'ORIGINAL_REQUIRED', 'Link at least one original photo through Capture before generating a world.');
  for (const [key, value] of Object.entries(state.previews)) if (value.expires <= Date.now()) delete state.previews[key];
  check(Object.keys(state.previews).length < 100, 429, 'TOO_MANY_PREVIEWS', 'Finish an existing preview first.');
  const plan = { id: uid(), eventId, revision: state.revision, inputHash: evidence.inputHash, title: evidence.title,
    environment, season, sourceIds, evidence, provenance: 'imagined', provider: 'local-procedural-v1',
    units: 'm', coordinateSystem: 'right-handed-y-up', scaleConfidence: null };
  const previewToken = uid();
  const expires = Date.now() + 5 * 60_000;
  state.previews[previewToken] = { kind: 'world', actor, expires, plan };
  return { previewToken, expires: new Date(expires).toISOString(), plan,
    diff: { label: 'Generate an imagined ' + environment + ' memory world',
      text: sourceIds.length + ' original photo stops · ' + season + ' surroundings. Geometry and placement are procedural interpretations, not a reconstruction.' } };
}

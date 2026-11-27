# Proposed internal transport contract v1.0
API base `/v1`, authenticated bearer/session, JSON unless upload. Resource scope enforced server-side; IDs are opaque. All timestamps ISO 8601 with timezone; coordinates scene-local [x,y,z]. Response success `{ok:true,revision,data}`; errors `{ok:false,code,message,revision?,candidates?}`. 400 invalid, 401 unauth, 403 forbidden, 404 inaccessible, 409 revision/ID conflict, 429 quota, 503 provider unavailable. Never expose provider secrets or raw errors.

| Method | Path | Semantics |
|---|---|---|
| POST | /projects | Create private project |
| GET | /projects/:p/snapshot | Graph, views, jobs, revision, allowed provenance; paginated media |
| POST | /projects/:p/uploads | Signed upload intent for approved mime/size |
| POST | /projects/:p/uploads/:id/complete | Validate object, idempotently enqueue ingestion |
| GET | /projects/:p/search?q= | Authorized ranked source IDs/reasons |
| GET | /projects/:p/gaps?eventId= | Nonleading proposed question |
| POST | /projects/:p/previews | Validate proposed command, return token/diff/cost if applicable |
| POST | /projects/:p/commands | Validate envelope and type payload, atomic commit, return revision |
| POST | /projects/:p/session | Select event, view, lens or anchor; per actor session (no graph revision) |
| POST | /projects/:p/jobs | Confirm compile token; reserve budget; enqueue immutable manifest |
| GET | /projects/:p/jobs/:id | Actual job status |
| GET | /projects/:p/events | SSE revision/job/session events; authenticated, Last-Event-ID replay or snapshot |
| GET | /projects/:p/artifacts/:id/access | Short-lived signed URL only for permitted asset/revision |
| DELETE | /projects/:p | Owner confirmation, revoke access/cancel jobs/delete |

Command payload map (reject unknown fields): event.correct `{patch:{title?,placeLabel?,startAt?,story?,position?}}` (position changes existing selected anchor only; ambiguous target must be resolved); recollection.add `{text,anchorId?,audioMediaId?}` (actor from auth); profile.set `{preset}`; anchor.add `{worldId,position,sourceIds}`; artifact.approve `{artifactId,dependencyHash}`; event.media.link `{mediaId,relation}`; undo `{revisionToUndo}` (latest eligible only). Validate target and all foreign IDs within same project. All graph mutations require preview except initial owner-confirmed ingestion linking; owner documents exception.

SSE envelope `{seq,kind,projectId,revision,data}`; kinds `revision.committed`, `job.changed`, `session.changed`, `resync.required`. No full media bytes. Client ignores duplicates, fetches snapshot if gap. Session selection separately scoped to user/pairing. Job deps list `{entityType,entityId,version}` and `inputHash` canonical stable serialization; artifact hash includes profile/model/manifest versions as relevant. Jobs use durable lease, bounded attempts, status `queued|running|ready|failed|stale|cancelled`; approval separate. Worker completion verifies dependencies and permission before attach. Exports are immutable snapshots.

Provider adapters: `Vision.describe(media)`, `World.submit(input)`, `World.poll(providerId)`, `World.download(result)`, `Video.submit(input)`, `Video.poll(id)`, `Render.render(manifest)`. Return typed results/error, no imaginary provider endpoints. Real adapters verify current vendor docs and terms. No actual provider calls in fixtures.

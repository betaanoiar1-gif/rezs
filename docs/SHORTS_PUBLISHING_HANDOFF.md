# Shorts Publishing Handoff (Phase 4)

Phase 4 adds an explicit local scheduling boundary after Phase 3F approval. It reuses AgentTube's `PublishingSchedulingAgent`, `publish_schedule`, queue processor, YouTube uploader, and reconciliation behavior. Approval still does not schedule or publish.

## Endpoint

`POST /api/production/shorts/:productionJobId/schedule`

The route uses the existing API-key protection and requires:

```json
{
  "confirmed": true,
  "publishTime": "2026-10-01T15:00:00.000Z",
  "privacyStatus": "private"
}
```

`publishTime` must be an explicit future ISO timestamp. `privacyStatus` must be `private`, `unlisted`, or `public`. These are the only accepted scheduling inputs; approved title, description, tags, category, artifact, provenance, and synthetic-media determination come from the canonical approved snapshot and cannot be overridden.

Scheduling creates or reuses a local `publish_schedule` row and changes canonical production status to `scheduled`. It does not call YouTube. The existing queue may publish a due item later when automation is enabled. Existing YouTube behavior is unchanged: a future `publishAt` upload uses private visibility, and accepting a local timestamp is not a guarantee of future public publication.

## Eligibility

The handoff requires:

- the complete Phase 3A–3C chain and immutable specification remain valid;
- canonical review and production are Phase 3F `approved` for an initial schedule;
- all five human confirmations and the explicit synthetic-media determination remain present;
- final approval gate evidence is structurally valid;
- provenance is exactly `verified` or `not_required`;
- verified source records still exactly match the approved Phase 3A source records;
- Phase 3C, canonical, embedded-audio, and Phase 3F artifact paths agree;
- approved size and SHA-256 agree with Phase 3C evidence and current bytes; and
- the artifact remains a non-empty regular MP4.

`operator_reviewed` / `human_reviewed_no_recorded_sources` remains non-verified and cannot be scheduled. Phase 4 does not invent sources or waivers.

## Embedded audio

Topic-generated Shorts upload their validated final MP4 directly. No separate audio file is created. The publishing agent accepts embedded audio only for `contentType: short` when the embedded evidence passed, names a codec and positive duration, points to the same final MP4, carries passed final-video validation, and is tied to the approved artifact identity. Existing separate-audio and intentional-silence behavior is unchanged.

## Artifact identity

The schedule freezes `{ path, sha256, fileSize }`. Immediately before upload, the publishing agent checks the path, regular-file status, size, and SHA-256 again. A replaced or changed artifact becomes `failed`, canonical production becomes `needs_attention`, and upload is not attempted.

The identity chain is:

`Phase 3C digest = Phase 3F digest = schedule digest = pre-upload digest`

## Metadata and synthetic media

Canonical snapshot metadata is copied unchanged. A numeric approved category is passed as `categoryId`; otherwise the existing YouTube metadata fallback remains in effect. The Phase 3F determination maps without inference:

- `contains_synthetic_media` → `true`
- `does_not_contain_synthetic_media` → `false`

The boolean is frozen in schedule metadata and sent through the existing YouTube `containsSyntheticMedia` field.

## Idempotency and lifecycle

An identical repeated handoff returns the existing schedule and repairs an interrupted `approved` → `scheduled` status update. A different time, privacy choice, or artifact identity returns `SCHEDULE_CONFLICT`; operators must use the existing reschedule workflow.

Canonical topic-generated Short status follows `scheduled`, `uploading`, `uploaded`, `reconciliation_required`, `failed`, and `published`. Publishing rechecks approval and provenance. Failed, uncertain, or merely uploaded items are never marked published. Existing uncertainty handling blocks blind retry; the known residual limitation is the existing concurrent first-schedule race because `publish_schedule.production_id` has no unique constraint.

## Deterministic verification

No live YouTube, MPT, AI, or Clean APIs calls are required. From `agenttube/`:

```bash
node --test test/shorts-publishing-handoff.test.js test/shorts-review-service.test.js test/shorts-production-execution-service.test.js
npm run test:integration
npm run lint
```

From the repository root:

```bash
git diff --check
```

Phase 3D remains `BLOCKED_REAL_RUNTIME`; mocked publishing tests do not prove a live MPT-to-YouTube workflow.

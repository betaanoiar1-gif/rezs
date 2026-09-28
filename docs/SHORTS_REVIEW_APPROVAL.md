# Shorts Human Review and Approval Handoff (Phase 3E)

## Scope

Phase 3E hands a completed Phase 3C Short into AgentTube's canonical production and review records. It is a local human-review boundary only. It does not render or regenerate content, retry MoneyPrinterTurbo, schedule publication, enqueue a publishing agent, call YouTube, upload, or publish.

The accepted chain is:

`shorts_planning_jobs → shorts_production_preparations → production_jobs → productions → content_reviews → human decision`

The canonical production ID and review ID are the Phase 3C `production_jobs.job_id`. No schema or mapping table was added.

## Eligibility and safeguards

A handoff is accepted only when all of the following are true:

- the production job exists and is exactly `SUCCEEDED / ARTIFACT_DOWNLOADED`;
- its persisted artifact validation passed;
- its artifact path is a non-empty regular file;
- the linked preparation is `PRODUCTION_READY`, passed its quality gate, and contains an MPT request;
- the linked planning job succeeded and has its planning artifact;
- all planning/preparation/production identifiers match; and
- the immutable MPT script exactly equals the Phase 3A approved narration.

Failures use structured codes including `PRODUCTION_NOT_FOUND`, `PRODUCTION_NOT_READY`, `ARTIFACT_NOT_FOUND`, `ARTIFACT_INVALID`, and `PROVENANCE_INCOMPLETE`. API errors do not include stack traces or credentials. Sensitive URL query values in source records are redacted from responses.

The handoff reuses `productions`, `production_snapshots`, `production_scenes`, `content_reviews`, and `content_provenance`. It preserves the exact approved narration, metadata, scene plan, linked IDs, validation record, and original MP4 path. It does not create a second artifact or a fabricated narration file.

## API

All mutation routes use the server's existing API-key protection. The read route follows existing production read behavior.

### Create or reuse handoff

`POST /api/production/shorts/:productionJobId/review`

Materializes the canonical records and runs existing operator quality checks. A passing gate starts in `needs_review`; blocking findings start in `needs_attention`. Repeating this request returns the existing review without recreating content.

### Read review

`GET /api/production/shorts/:productionJobId/review`

Returns the immutable review subject, artifact validation metadata, quality checks, truthful research/factual state, and current human-review state.

### Record decision

`POST /api/production/shorts/:productionJobId/review/:action`

Allowed actions are `approve`, `reject`, and `request-changes`.

Approval requires all confirmation fields to be exactly `true`:

```json
{
  "reviewer": "operator identity",
  "confirmations": {
    "factualContentReviewed": true,
    "rightsConfirmed": true,
    "metadataReviewed": true,
    "privacyReviewed": true,
    "syntheticMediaReviewed": true
  },
  "privacyStatus": "private",
  "syntheticMediaDetermination": "contains_synthetic_media",
  "notes": "Optional review note"
}
```

`privacyStatus` may be `private`, `unlisted`, or `public`, but this is only recorded review intent and never schedules or publishes anything. `syntheticMediaDetermination` is separately mandatory and must be either `contains_synthetic_media` or `does_not_contain_synthetic_media`; it records the actual human outcome rather than inferring one from the review checkbox.

Before persisting approval, the service runs the final approval gate in the same operation. It revalidates the completed Phase 3 chain and immutable specification, compares the current artifact size and SHA-256 with Phase 3C evidence, reruns the existing strict MP4 validator, applies the candidate human provenance state, and reruns operator quality checks. Any remaining blocking technical or content check prevents approval. The approval transaction persists provenance, locked scenes, final quality evidence, human evidence, and approved production/review state together.

Reject and request-changes require `reason` (or `notes`). Request changes maps to the existing canonical `needs_attention` state. Neither action mutates the approved script, scenes, artifact, or production provenance.

The first completed approval or rejection locks the decision. Repeating the same decision is idempotent; a conflicting terminal decision returns `REVIEW_LOCKED`. A repeated request-changes decision is also idempotent.

## State machine

- completed Phase 3C + passing quality gate → `needs_review`
- completed Phase 3C + blocking quality findings → `needs_attention`
- review → approve with five confirmations → `approved`
- review → reject with reason → `rejected`
- review → request changes with reason → `needs_attention`

Approval has no transition to scheduling or publishing in Phase 3E.

## Provenance and research truthfulness

When Phase 3A performed no research, Phase 3E records `researchStatus: not_performed`, no invented sources, and `factCheckStatus: pending_review`. Human approval without recorded sources becomes `human_reviewed_no_recorded_sources`; it does not claim source verification and uses provenance status `operator_reviewed`, which does not satisfy the existing downstream publish provenance gate. Approval with actual recorded sources may use `verified_with_reviewed_sources` and provenance status `verified`.

## Embedded MP4 audio

Topic-generated Shorts retain audio embedded in the validated final MP4. Phase 3C stores the validated file size and SHA-256 digest alongside its stream, codec, resolution, duration, container, and decode evidence. Approval recomputes the digest, checks the size, and reruns that same strict validator, so a same-path or same-size replacement cannot reuse stale evidence.

Generic operator checks accept embedded-audio evidence only for Shorts when:

- persisted embedded-audio validation passed;
- an audio codec and positive duration are present;
- final-video validation passed;
- both records reference exactly the same artifact path; and
- that final artifact exists as a file.

This narrowly extends quality-check compatibility without weakening existing separate-audio or scene-audio paths.

## Deterministic verification

From `agenttube/`:

```bash
npm ci --ignore-scripts
node --test test/shorts-review-service.test.js
npx eslint services/shorts-review-service.js utils/operator-service.js index.js test/shorts-review-service.test.js
```

Run the existing Phase 3A–3C, MoneyPrinterTurbo adapter, AgentTube integration, review/approval, and publishing-safety tests named in the repository test directory before committing. From the repository root, also run:

```bash
git diff --check
```

These checks do not constitute real MoneyPrinterTurbo runtime verification. Phase 3D remains `BLOCKED_REAL_RUNTIME` where that external runtime is unavailable.

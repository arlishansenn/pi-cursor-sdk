# ADR 0001: Session identity and checkpoint restore

## Status

Accepted 2026-09-30. Stage 1 implemented. Stage 2 is implemented and enabled by default since 2026-10-01; `PI_CURSOR_CHECKPOINT_RESTORE=0` disables it.

## Context

Pi passes `options.sessionId` on every agent stream call (`@earendil-works/pi-agent-core` 0.87.1 `createLoopConfig`). `sendSessionAffinityHeaders` only adds HTTP headers inside Pi's OpenAI/Anthropic adapters. This provider receives stream options, not those headers.

The local agent pool is already keyed by the lifecycle scope in `src/cursor-session-scope.ts`. A second registry would split ownership.

Installed `@cursor/sdk` 1.0.32 `Agent.resume(agentId, options?)` takes an agent id and agent options. `AgentCheckpointStore.loadLatest` reads `agents.latestCheckpoint` and decodes `SdkConversationStateStructure`, published as `unknown`. Checkpoint blob bytes are content-addressed. Run rows keep their own start/latest refs. There is no public restore, rewind, or checkpoint argument.

## Decision

- Remove the fixed 20-send recreate. `incrementalSendCount` stays on send state for diagnostics only.
- Bind `options.sessionId` in the existing scope module for the whole provider call, including queue selection and the turn runner:
  - a request id that matches the lifecycle session id binds the parent session-file or ephemeral scope;
  - a missing request id leaves the session-file or ephemeral scope unchanged;
  - a request id that **differs** from the lifecycle session id is a **nested Cursor run** (pi compaction summarization, pi-btw `/btw` child sessions, and similar). It uses request isolation (`__request__:` pool) and does not touch the parent session agent. Compaction summarization ids are one-shot and reset that nested pool after the turn. Reused nested ids (pi-btw child sessions) keep the nested agent so the next `/btw` turn does not `Agent.create` again. Session shutdown still disposes leftover `__request__:` pools. Mid-turn scope corruption still fails closed via `assertCursorRequestScope`;
  - a request id with no lifecycle scope is async-context-local and selects a `__request__:` pool key only inside that call. It does not mutate a process-global binding.
- One action-turn context covers the identity decision and later create/resume/send records. A nested runner reuses that turn id.
- Do not send `x-session-affinity`, and do not use the pi session id as a Cursor agent id or send idempotency key.
- Enable historical restore by default only after a copied agent can be resumed from the same owned store, continue from the committed pi boundary, survive concurrent writes, interruption, rollback, and reopen-send, and persist unavailable points. These gates passed on 2026-10-01 (see Consequences).

## Checkpoint feasibility (SDK 1.0.32)

| Gate | Result |
| --- | --- |
| Public resume accepts a historical checkpoint | Fail. `Agent.resume(agentId, options?)` has no checkpoint parameter. |
| Local resume reads a caller-selected checkpoint | Fail. It loads the agent row. `latestCheckpointRef` is then used only to decide the default mode. The executor calls `checkpointStore.loadLatest(agentId)`, which reads `agents.latestCheckpoint.rootBlobId`. |
| Pi history position maps to one committed SDK state | Not established. The public checkpoint payload is `unknown`, so a pi message cannot be matched to a blob by type. |
| Copying only the head blob into a new agent | Fail. The next send result was empty. This is not the same experiment as same-agent rewind. |
| Same-agent rewind | Not accepted on 2026-09-30: the probe resumed and could switch back, but did not prove isolation. Accepted on 2026-10-01 (#18): `docs/evidence/cursor-rewind-isolation-2026-10-01.md` shows no discarded-branch leak in answers or newly written blobs across multi-turn, repeated, alternating, and reopened rewinds. |
| Public copy-on-write into a new agent | Not present. `saveCheckpoint` takes one agent id and an opaque checkpoint and updates that agent's latest ref. |
| Cloud historical restore | Not present. Cloud resume uses the same `(agentId, options)` signature and no checkpoint argument. |

The authenticated experiment used `grok-4.6` with `fast=false`, `settingSources: []`, and a key resolved in memory. It created two committed sends in a temp store. The first send wrote 11 blobs. Copying all of them to a new `agent-*` row and setting that row's head to the first head resumed a send whose stored blobs contained the first marker and not the second. The source row kept both markers and not the copy's later marker. Reopening the store resumed the copy. `loadLatest` and `getFullConversation` did not expose those turns. The required blob subset, pi-message mapping, concurrent writes, interruption, and cloud behavior were not tested. No real session store was opened, and the temp stores were removed.

## Consequences

Compatible in-process turns keep one Cursor agent past 20 incremental sends. Checkpoint restore is on by default; `PI_CURSOR_CHECKPOINT_RESTORE=0` disables it. A restore point matches when the current context extends the point's sent context the way an incremental send would. The lookup runs on context divergence with a live pooled agent and before creating into an empty pool of a persisted session, because pi `/tree` resets the pool and a restarted process starts empty. The empty-pool lookup opens only the scope's own derived session store. It reuses persisted agent state across an agent lifecycle boundary, so it runs only when local resume is on, and it is skipped when local resume has a matching persisted handle for a never-rewound agent, because that resumes the agent as recorded. With local resume off, `/tree` and restart create/bootstrap; the live-pool divergence lookup still runs. Restore rewinds the point's own source agent when it is idle and still holds the point's head blob: the pooled agent is released first, the source row's `latestCheckpoint` is set to the point's head, and the same agent id is resumed. Otherwise it copies the point into a new agent. A rewound agent's head can belong to any pi branch, so a `cursor-sdk-checkpoint-rewind` custom entry marks it before the row changes, the marker is read from all session entries, and persisted local-resume handles for a marked agent are refused; only a ledger point, which names its head, restores it. A process killed between the marker and the row update leaves a marked agent whose handles are refused; that costs one create/bootstrap, not a leak. Discarded-branch blobs stay on a rewound agent until it is deleted. Explicit `/cursor-local-resume-cleanup` can delete an agent that another branch's points rewind; that restore then falls back to create/bootstrap. Real-SQLite tests cover rewind, the marker guard, copy under a competing writer, in-process copy interruption cleanup, resume failure rollback, and reopen durability; `npm run smoke:checkpoint-restore` covers branch isolation through the live provider path. A process killed mid-copy leaves the copy target in the session store; nothing reclaims it. A resume that succeeds but whose next send fails is a turn error, not a fallback. #8 measured backend cache use (`docs/evidence/cursor-cache-benefit-2026-10-01.md`): reuse follows agentId continuity, so the copy's first turn mostly misses cache like a bootstrap, while a same-agent rewind hit in 4 of 5 samples, which is why restore prefers rewind (#18). History navigation uses create/bootstrap when restore is disabled or no point matches.

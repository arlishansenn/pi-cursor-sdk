# Cursor checkpoint restore feasibility — 2026-09-30

Installed packages: `@cursor/sdk` 1.0.32, `@earendil-works/pi-coding-agent` 0.87.1, nested `@earendil-works/pi-agent-core` 0.87.1.

The 2026-09-26 note in `docs/cursor-model-ux-spec.md` is a separate model-catalog date. This evidence was produced on 2026-09-30.

## Verified from the installed package

- `dist/esm/stubs.d.ts`: `static resume(agentId: string, options?: Partial<AgentOptions>)`. No checkpoint parameter. `dist/esm/agent.d.ts` `SDKAgent` has no checkpoint method.
- `dist/esm/index.js` `Agent.resume`: cloud ids call `resumeCloudAgent(agentId, options)`; local calls `platform.resumeAgent(agentId, options)`.
- Local `resumeAgent` loads `store.getAgent(agentId)`. It uses `latestCheckpointRef` only as `const hasLatest = latestCheckpointRef !== null`, then chooses a default mode. It does not pass the ref to the executor as a history selector.
- The executor calls `checkpointStore.loadLatest(agentId)`. `loadLatest` reads `agent.latestCheckpoint.rootBlobId` and decodes it with `ConversationStateStructure.fromBinary`. The public type is `unknown`.
- `SqliteLocalAgentStore` checkpoints are content-addressed blobs. `saveCheckpoint` writes the caller's checkpoint and updates that same agent's `latestCheckpoint`.
- Official TypeScript SDK resume docs (https://cursor.com/docs/sdk/typescript#resuming-agents) document agent-id resume only.

## Reproducible temp-store check

`test/cursor-sdk-checkpoint-contract.test.ts` does this on an OS temp directory and deletes it:

1. `SqliteLocalAgentStore.open({ workspaceRef, stateRoot })`.
2. Create agent row `agent-probecontract` with `latestCheckpoint: null`.
3. The created document's `latestCheckpoint` is null. This is the field `loadLatest` reads; the public `SqliteLocalAgentStore` is not assignable to `createAgentPlatform`'s `AgentRunStore`, so this check does not call `loadLatest` directly.
4. `Agent.create` with api key `invalid-user-api-key` rejects `Invalid User API Key`.
5. The stored `latestCheckpoint` is still null, and checkpoint and run lists for that agent are empty.

The checked-in test reads no API key and opens no user or project store. Authentication failure in that test does not prove an accepted create lacks a restorable checkpoint. The separate authenticated probe below does.

## Authenticated temp-store result

A direct Node probe resolved the Cursor key in memory, used local `grok-4.6` with `fast=false` and `settingSources: []`, and deleted every OS temp store.

- Create writes no checkpoint. The first successful send writes one head and 11 blobs. The second send advances the head. The first head blob remains unchanged. The head blob does not contain the plaintext marker; child blobs do.
- `store.deps.checkpointStore.loadLatest` returns null while the agent row has a checkpoint. `getFullConversation` returns no turns. This public reader is not the working restore path.
- Copying only the head blob and setting `latestCheckpoint` does not restore the conversation. The next result is empty.
- Copying all 11 first-send blobs to a new `agent-*` row, then setting only that row's head, does restore it. `Agent.resume` requires an explicit model. The copy's next stored blobs contain the first marker and not the second. The source still contains both markers and not the copy's later marker. Reopening the same temp store and resuming the copy accepts another send. Source and copy runs stay separate.

## Same-agent rewind result

A later temp-store probe, using the same local `grok-4.6` setup, tried the preferred same-agent rewind. After two successful sends, it updated only that agent row's `latestCheckpoint` from the second head back to the first. The old blobs were not deleted. `Agent.resume` on the same id accepted another send.

The persisted blob set still contained the second marker after that send. The first 11 blob bytes remained intact, all three run rows finished, and a second head update back to the second checkpoint also accepted a send. No active run remained. Those facts do not satisfy branch isolation: one agent row retains both branches' checkpoint bytes, and the public blob API exposes no ownership link that distinguishes the rewound head from the discarded branch.

Same-agent rewind is not accepted as the default. The retained second marker shows the store still contains the discarded branch, but this probe did not decode the rewound conversation, so it does not by itself prove that the new head includes that marker. Rewind was not interrupted, and no concurrent writer was run. Sanitized output is in `/tmp/issue3-stage2/rewind.stdout.txt` when that temp probe output is still present. The production provider does not enable either rewind or blob copy.

## Production enablement gate

`Agent.resume` on a copied checkpoint in a reopened temp store, using api key `invalid-user-api-key`, fails with `AuthenticationError: Invalid User API Key` at `GET /v1/models` before a send. A hermetic reopen-resume-send test therefore cannot pass without a live credential. Production restore stays disabled rather than enabling an unproven path.

## Not established

- The minimal required blob subset and a pi message-to-blob mapping.
- Concurrent writers, interrupted copies or rewinds, rollback, or cloud agents.

No production restore was added. The current provider path remains create/bootstrap when pi context no longer matches the pooled agent.

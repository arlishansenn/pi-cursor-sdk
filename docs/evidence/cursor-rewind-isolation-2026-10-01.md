# Same-agent rewind branch isolation — 2026-10-01

Isolation probe for #18, step 1. Installed packages: `@cursor/sdk` 1.0.32, pi 0.87.1. Model `cursor/grok-4.6:slow` (selection `grok-4.6`, `effort=high`, `fast=false`), direct SDK on a temp `SqliteLocalAgentStore`, `settingSources: []`.

## Result

In 5 of 5 samples, every turn after a same-agent rewind continued from the selected head only. The model never named a code word from a discarded branch (0 of 25 turns). No blob written after a rewind held a discarded word (0 of 25 turns). The same scan found the words each turn legitimately wrote in 25 of 25 turns, so a clean scan is a real negative. This covers multi-turn sends after a rewind, a second rewind, alternation back to a discarded branch, and a store reopen.

This removes the open point from `cursor-checkpoint-restore-feasibility-2026-09-30.md` ("Same-agent rewind result"): discarded-branch bytes stay in the agent's blob set, but the rewound conversation does not read them. The evidence is behavioral plus byte scans. The rewound head was not decoded, because the SDK publishes the checkpoint payload as `unknown`.

## Method

Command: `node scripts/rewind-isolation-probe.mjs --samples 5 --out <path>` (needs Cursor auth; builds `dist/` first). Each sample uses one agent and three code words with random suffixes:

1. T1 "remember W1" (head h1), T2 "remember W2" (head h2). Dispose.
2. Rewind: set the agent row's `latestCheckpoint` to h1 (refused if `activeRunId` is set), `Agent.resume` on the same id.
3. `rewindToW1`: list words. Must name W1, not W2.
4. `rememberW3` (head h3), then `listAfterW3`: must name W1 and W3, not W2.
5. Dispose, close and reopen the store, rewind to h2. `reopenRewindToW2`: must name W1 and W2, not W3.
6. Rewind to h3. `rewindToW3`: must name W1 and W3, not W2.

For each checked turn the probe lists the agent's blobs before and after the send (following `nextCursor` pages), and scans only the new blobs. A turn passes when the run finished, the answer names every expected word and no discarded word, no new blob holds a discarded word, and new blobs hold every word the turn wrote (positive control).

## Data (5 samples)

| Check | pass | cacheRead share per sample |
| --- | --- | --- |
| rewindToW1 | 5/5 | 99.6/99.3/27.7/99.4/99.3% |
| rememberW3 | 5/5 | 98.6/98.3/98.5/98.5/98.3% |
| listAfterW3 | 5/5 | 98.9/98.5/98.8/98.7/98.6% |
| reopenRewindToW2 | 5/5 | 0.0/17.1/98.7/98.8/98.7% |
| rewindToW3 | 5/5 | 98.9/27.2/99.7/99.7/99.6% |

Each sample ends with 59 blobs and 7 run rows on the one agent, and no active run. Each checked turn wrote 8 new blobs. Raw numbers without prompt text, code words, or agent ids: `cursor-rewind-isolation-2026-10-01.json`. A 1-sample pilot run before this passed the same checks.

## Observations

- Cache reuse after a rewind is high in most turns (21 of 25 above 90%), which agrees with #8 (`cursor-cache-benefit-2026-10-01.md`). Returning to a discarded branch after a store reopen missed in 2 of 5 samples.
- Discarded-branch blobs stay on the agent until the agent is deleted. A rewind writes no copy, so it adds fewer blobs than copy restore, which duplicates the selected point's blobs under a new agent.
- `Agent.resume` takes the agent id only; the rewind is the row update. The row update is not atomic with other writers to that row.

## Not established

- Decoded content of a rewound head.
- Concurrent writers on the same agent row during a rewind, interruption between the row update and the resume, other models, and cloud runtime.

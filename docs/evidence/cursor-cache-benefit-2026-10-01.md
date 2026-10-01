# Cursor backend cache benefit of identity and checkpoint restore — 2026-10-01

Measurement for #8. Installed packages: `@cursor/sdk` 1.0.32, pi 0.87.1. Model `cursor/grok-4.6:slow` (selection `grok-4.6`, `effort=high`, `fast=false`), local runtime, `PI_CURSOR_SETTING_SOURCES=none`.

## Result

Backend cache reuse follows agentId continuity, not prompt content. With byte-identical checkpoint blobs and send text, resuming the **same** agentId after a rewind read about 99% of the prompt from cache in 4 of 5 samples. Resuming a **copy** under a new agentId read 2–18% in 5 of 5 samples. That is the same range as a newly created agent.

So default-on checkpoint restore (copy to a new agentId) mostly does not reuse the backend cache in this measurement (1 of 5 B samples hit). Its post-restore turn has about the same uncached input as a create/bootstrap turn. Its measured benefit is lower latency than bootstrap. Same-agent rewind would reuse the cache, but it is still rejected for branch isolation (see `cursor-checkpoint-restore-feasibility-2026-09-30.md`).

## Method

Command: `node scripts/cache-benefit-experiment.mjs --samples 5 --out <path>` (needs Cursor auth; builds `dist/` first). Every group runs three turns on a new agent in a new temp workspace:

1. T1: a unique ~6k-token document plus "remember ALPHA".
2. T2: "remember BETA".
3. T3 (measured): "list the code words".

| Group | Lane | T3 |
| --- | --- | --- |
| A | provider `streamCursor` | incremental follow-up after BETA, same agent (no divergence) |
| B | provider, default restore | branch back to after ALPHA; checkpoint copied to a new agentId, resumed, incremental send |
| C | provider, `PI_CURSOR_CHECKPOINT_RESTORE=0` | same branch; new agent, full bootstrap replay |
| B′ | direct SDK | same raw texts; T1 checkpoint blobs copied to a new agentId (`copyCursorCheckpointPoint`), resumed |
| D | direct SDK | same raw texts; same agent's `latestCheckpoint` rewound to the T1 head, `Agent.resume` on the same id |

B uses the live-pool divergence path; the `/tree` empty-pool path also resumes a copy under a new agentId, so it was not run separately. B′ and D differ only in agentId. Each (sample, group) uses its own document nonce, so no group can read another group's cache. Group order rotates per sample. T3 follows T2 without an added delay in every group. Usage is the SDK `turn-ended` usage: the provider usage-log line (`source: "turn"` on every turn) or the SDK `onDelta` update. `inputTokens` is the full prompt; `cacheReadTokens` is part of it. Every T3 answer was correct: A recalled ALPHA and BETA; B, C, B′, and D recalled ALPHA and not BETA. Every B T3 resumed a copy with no create and sent incrementally. Every C T3 created a new agent and bootstrapped.

## T3 data (5 samples)

| Group | cache hits (>90% read) | median input | median cacheRead | median uncached | median ms |
| --- | --- | --- | --- | --- | --- |
| A | 5/5 | 23728 | 23424 | 288 | 3940 |
| B | 1/5 | 23477 | 3712 | 19847 | 9392 |
| C | 0/5 | 23233 | 2304 | 20899 | 14386 |
| B′ | 0/5 | 23055 | 1792 | 21235 | 7736 |
| D | 4/5 | 23117 | 23040 | 107 | 5642 |

Per-sample T3 cacheRead share: A 98.8/99.2/98.8/98.7/98.7%, B 0.0/98.8/7.7/15.8/15.8%, C 9.9/16.0/30.8/9.9/9.9%, B′ 7.7/2.2/18.3/7.8/10.0%, D 99.6/99.7/99.4/5.0/99.5%. Same-agent T2 turns hit in 23 of 25 runs. Raw numbers without prompt text: `cursor-cache-benefit-2026-10-01.json` (the script's output with its `agentId` and `sourceAgentId` fields removed). A 1-sample pilot run before this showed the same pattern (D 99%, B′ 2%).

## Observations

- About 17k of the ~23k input tokens are Cursor's own prompt. A new agent's first turn reads 0–53% from cache, so some cross-agent prefix reuse exists, but it is small and unstable.
- Restore does not reduce input size: B and C both send about 23k tokens to the model, because the restored state holds the same conversation the bootstrap replays.
- C produced more output (median 415 vs 55–89 tokens) and was the slowest group.
- `cacheWriteTokens` was 0 on every turn, so cache writes are not measurable on this model.
- Dollar cost is not measurable here: plan usage reports no per-turn charge. Token counts are the proxy.
- Misses happen on the same agent too (D one sample, T2 two runs). Cache affinity is likely but not guaranteed.
- Some T1 runs report about 47k input from two model calls inside one run. T1 is not the measured turn.

## Not established

- Why agentId matters. The behavior is consistent with backend cache routing or keying by agent or conversation id; the SDK bundle mapping from `agentId` to a request field is still unconfirmed.
- Other models, longer transcripts, longer gaps between turns (cache expiry), and cloud runtime.

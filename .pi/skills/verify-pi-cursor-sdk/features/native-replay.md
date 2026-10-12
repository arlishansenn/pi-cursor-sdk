# Native replay cards

A user watching a Cursor-model TUI turn sees **native replay** cards for host tools (`read`, `bash`, …) when replay is on, and **Cursor MCP** cards for configured MCP. not pi card names as callable tools.

## Sub-features

- **Host tools:** replayable SDK tool types as cards (`docs/cursor-native-tool-replay.md`).
- **Configured MCP:** ambient/user/plugin MCP shown as Cursor MCP activity.
- **Pi bridge:** exposed tools are `pi__*` MCP names; history labels are not callable.

## How to get to it (user POV)

Run TUI, JSON, or RPC with native display on. Print mode does not register replay wrappers. `PI_CURSOR_NATIVE_TOOL_DISPLAY=0`, `PI_CURSOR_REGISTER_NATIVE_TOOLS=0`, wrapper conflicts, or inactive tools can prevent structured replay. User sees replay after completed SDK tools.

## Driving it with verify-pi-cursor-sdk.mjs

After the numeric allowance setup in [SKILL.md](../SKILL.md), run:

```bash
node .pi/skills/verify-pi-cursor-sdk/bin/drive-rpc.mjs native-replay
```

This reserves one turn. Require a `tool_execution_start` whose path resolves to this checkout's `package.json`, a matching `cursor-replay-*` read completion with `isError: false` and package content, and a successful assistant package-name answer. The helper rejects failed reads and wrong paths.

This proves one host read through structured RPC. It does not prove configured MCP inventory, Pi bridge inventory, rendered cards, or screenshots. The former PTY automation was removed because cumulative transcript markers did not prove rendered terminal state. Existing terminal captures establish transcript markers only. Visible TUI inspection remains separately authorized manual work, not this helper's proof.

## Gotchas

- `listTools` does not enumerate Cursor host tools.
- Pi `--no-tools` still leaves Cursor host/MCP callable.
- Visual smoke is opt-in spend + Playwright; not the skill self-proof.

# Slash /cursor-tools

`/cursor-tools` reports the current Pi bridge surface, manifest setting, and raw/effective `PI_CURSOR_SETTING_SOURCES`. Cursor host/MCP descriptions are representative guidance, not an inventory fetched from an SDK agent. The command does not need a selected Cursor model and does not send a model request.

## Drive

After launch and Doctor, run the owned isolated RPC helper:

```bash
node .pi/skills/verify-pi-cursor-sdk/bin/drive-rpc.mjs slash-cursor-tools
```

It requests `get_commands`, requires `cursor-tools`, then sends RPC `prompt` with `/cursor-tools`. Installed Pi 0.87.1 dispatches the slash before model handling. Require both a successful prompt acknowledgement and `extension_ui_request` with `method: notify` and `Cursor tool surfaces` text. Do not wait for `agent_end`; no model turn occurs.

Evidence is saved under `.artifacts/verify-pi-cursor-sdk/evidence/slash-cursor-tools/run-*/`. HOME and session storage are disposable. The helper verifies termination of its owned process group before recording PASS or removing HOME. A cleanup failure records FAIL and retains private scratch.

## Limits

`get_commands` alone proves registration, not report execution. This feature does not prove ambient MCP discovery or `ctx_*` exposure. RPC notifications are JSONL UI requests, not ordinary report text. The packaged RpcClient 30-second timeout is a response wait, not a universal model-completion deadline.

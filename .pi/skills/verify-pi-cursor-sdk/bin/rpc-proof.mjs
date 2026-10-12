import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { repo } from './owned-run.mjs';

export function assertNativeRead(events, packageName) {
  const read = events.find(event => event.type === 'tool_execution_end' && event.toolName === 'read' && event.toolCallId?.startsWith('cursor-replay-') && event.isError === false && events.some(start => start.type === 'tool_execution_start' && start.toolCallId === event.toolCallId && typeof start.args?.path === 'string' && resolve(repo, start.args.path) === resolve(repo, 'package.json')) && event.result?.content?.some(block => block.type === 'text' && block.text.includes(packageName)));
  assert.ok(read, 'Successful native package.json read with package content not observed');
  assert.ok(events.some(event => event.type === 'message_end' && event.message?.role === 'assistant' && event.message.stopReason === 'stop' && event.message.content?.some(block => block.type === 'text' && block.text.includes(packageName))), 'Successful assistant package-name result not observed');
}

export function assertNestedReuse(actions) {
  assert.ok(!actions.some(action => action.reason === 'session_id_conflict' || action.action === 'session_id_conflict'), 'session_id_conflict observed');
  const nested = actions.filter(action => action.action === 'session_identity' && action.reason === 'nested_request');
  assert.equal(nested.length, 2, 'Expected two nested identities');
  assert.ok(nested[0].scopeId && nested[0].scopeId === nested[1].scopeId, 'Nested scope not reused');
  assert.equal(actions.filter(action => action.action === 'agent_create' && action.phase === 'success' && action.scopeId === nested[0].scopeId).length, 1, 'Expected one nested agent creation');
}

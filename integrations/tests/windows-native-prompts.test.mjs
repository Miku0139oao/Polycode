import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureUserPrompt } from './windows-native-prompts.mjs';

const request = '<user_query>Search the isolated fixture.</user_query>';
const notification = '<system-reminder>\nMCP server connected:\n- fixture (1 tool)\nUse search_tool before use_tool.\n</system-reminder>';

test('late native MCP notifications do not replace the fixture tool-result task', () => {
  const messages = [
    { role: 'user', content: request },
    { role: 'assistant', content: null, tool_calls: [{ id: 'grep-codex', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'grep-codex', content: 'actual fixture result' },
    { role: 'user', content: notification },
  ];
  assert.equal(fixtureUserPrompt(messages), request);
  assert.equal(messages.at(-1).content, notification);
  assert.equal(messages[2].content, 'actual fixture result');
});

test('title and dashboard requests remain auxiliary rather than replaying a prior task', () => {
  for (const prompt of ['<system-reminder>Generate a session title</system-reminder>', '<system-reminder>Write an ultra-short dashboard line</system-reminder>', 'CWD: fixture\nTranscript: earlier task']) {
    assert.equal(fixtureUserPrompt([{ role: 'user', content: request }, { role: 'user', content: notification }, { role: 'user', content: prompt }]), prompt);
  }
});

test('ordinary user messages and unknown reminders are not discarded', () => {
  for (const prompt of ['MCP server connected:\nPlease debug my connection.', '<user_query>' + notification + '</user_query>', '<system-reminder>Unknown notification</system-reminder>', 'Write the isolated output.']) {
    assert.equal(fixtureUserPrompt([{ role: 'user', content: request }, { role: 'user', content: prompt }]), prompt);
  }
});

test('multipart prompts and plural MCP connection notices retain the real task', () => {
  assert.equal(fixtureUserPrompt([{ role: 'user', content: [{ type: 'text', text: request }] }, { role: 'user', content: notification.replace('server connected', 'servers connected') }]), request);
  assert.equal(fixtureUserPrompt([{ role: 'user', content: notification }]), '');
});

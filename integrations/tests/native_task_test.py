#!/usr/bin/env python3
"""Native Task mock contracts only: no binary, TUI, or agent is launched here."""
import copy
import inspect
import io
import json
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import native_test
import native_pty
from native_mock import (CHILD_MARKERS, PROMPTS, TASK_CALL_IDS, TASK_MARKERS,
                         RESUME_CHILD_MARKERS, RESUME_MARKERS, returned_subagent_id)

# Observed wire keys: background (not generic TaskToolInput.run_in_background).
TASK_TOOLS = [{'type': 'function', 'function': {'name': 'spawn_subagent', 'parameters': {
    'type': 'object', 'properties': {
        'prompt': {'type': 'string'}, 'description': {'type': 'string'},
        'subagent_type': {'type': 'string'}, 'background': {'type': 'boolean'},
        'model': {'type': 'string'}, 'resume_from': {'type': 'string'}},
    'required': ['prompt', 'description', 'subagent_type', 'background']}}}]
PARENT_MODELS = {'codex': 'mock-beta', 'cursor': 'mock-cursor'}


def footer(subagent_id='observed-child-id'):
    return (f'\n<subagent_result>\nsubagent_id: {subagent_id}\nsubagent_type: general-purpose\n'
            f'To continue this subagent\'s conversation, use resume_from="{subagent_id}".\n</subagent_result>')


class TaskTests(unittest.TestCase):
    # Share the existing local HTTP fixture and asynchronous error accounting,
    # without inheriting/re-running its existing test methods.
    tearDown = native_test.MockTests.tearDown
    request = native_test.MockTests.request
    json = native_test.MockTests.json

    def setUp(self):
        native_test.MockTests.setUp(self)
        self.bridge.logged_in.update(codex=True, cursor=True)

    def parent_body(self, provider='codex'):
        return {'model': PARENT_MODELS[provider], 'stream': True, 'tools': copy.deepcopy(TASK_TOOLS),
                'messages': [{'role': 'user', 'content': PROMPTS['task_' + provider]}]}

    def child_body(self, provider='codex'):
        return {'model': PARENT_MODELS[provider], 'stream': True,
                'messages': [{'role': 'user', 'content': CHILD_MARKERS[provider] + '\nReply briefly.'}]}

    def sse(self, provider, body):
        response = self.request('POST', f'/{provider}/v1/chat/completions', body)
        self.assertEqual(response.status, 200)
        wire = response.read().decode()
        self.assertTrue(wire.endswith('data: [DONE]\n\n'))
        return [json.loads(line[6:]) for line in wire.splitlines()
                if line.startswith('data: ') and line != 'data: [DONE]']

    def reject(self, provider, body, error):
        self.expected_errors.append(error)
        status, response = self.json('POST', f'/{provider}/v1/chat/completions', body)
        self.assertEqual(status, 500)
        for marker in TASK_MARKERS.values():
            self.assertNotIn(marker, json.dumps(response))
        self.assertEqual(self.bridge.snapshot()['errors'], self.expected_errors)

    def issue(self, provider='codex', body=None):
        body = body if body is not None else self.parent_body(provider)
        chunks = self.sse(provider, body)
        calls = [call for chunk in chunks for call in chunk['choices'][0]['delta'].get('tool_calls', [])]
        self.assertEqual(len(calls), 1)
        self.assertEqual(chunks[-1]['choices'][0]['finish_reason'], 'tool_calls')
        call = {key: value for key, value in calls[0].items() if key != 'index'}
        self.assertEqual(call['function']['name'], 'spawn_subagent')
        self.assertFalse(self.bridge.native_tasks[provider]['verified'])
        return body, call

    def child(self, provider='codex', blocks=False):
        body = self.child_body(provider)
        if blocks:
            body['messages'][0]['content'] = [{'type': 'text', 'text': body['messages'][0]['content']}]
        chunks = self.sse(provider, body)
        self.assertFalse(any('tool_calls' in c['choices'][0]['delta'] for c in chunks))
        self.assertEqual(chunks[-1]['choices'][0]['finish_reason'], 'stop')
        text = ''.join(c['choices'][0]['delta'].get('content', '') for c in chunks)
        self.assertEqual(text, self.bridge.native_tasks[provider]['nonce'])
        return text

    def result_body(self, body, call, content):
        result = copy.deepcopy(body)
        if isinstance(content, str):
            content += footer('observed-' + call['id'])
        result['messages'].extend([{'role': 'assistant', 'tool_calls': [copy.deepcopy(call)]},
                                   {'role': 'tool', 'tool_call_id': call['id'], 'content': content}])
        return result

    def test_emits_observed_foreground_schema_without_overrides(self):
        ids = []
        for provider in PARENT_MODELS:
            with self.subTest(provider=provider):
                body, call = self.issue(provider)
                arguments = json.loads(call['function']['arguments'])
                self.assertEqual(set(arguments), {'prompt', 'description', 'subagent_type', 'background'})
                self.assertIs(arguments['background'], False)
                self.assertEqual(arguments['subagent_type'], 'general-purpose')
                self.assertIn(CHILD_MARKERS[provider], arguments['prompt'])
                self.assertTrue(arguments['description'])
                for forbidden in ('run_in_background', 'model', 'cwd', 'isolation', 'harness'):
                    self.assertNotIn(forbidden, arguments)
                for state in self.bridge.native_tasks.values():
                    self.assertNotIn(state['nonce'], json.dumps(body))
                    self.assertNotIn(state['nonce'], json.dumps(call))
                self.assertEqual(call['id'], TASK_CALL_IDS[provider])
                ids.append(call['id'])
                state = self.bridge.snapshot()['native_tasks'][provider]
                self.assertEqual(state['expected_model'], PARENT_MODELS[provider])
                self.assertTrue(state['issued'])
                self.assertEqual(state['child_calls'], 0)
                self.assertEqual(self.bridge.snapshot()['requests'][-1]['purpose'], 'interactive')
        self.assertEqual(len(set(ids)), 2)

    def test_child_before_parent_is_rejected_for_both_providers(self):
        for provider in PARENT_MODELS:
            self.reject(provider, self.child_body(provider), 'native Task child arrived before parent invocation')
            self.assertEqual(self.bridge.native_tasks[provider]['child_calls'], 0)

    def test_foreign_child_provider_and_model_are_rejected(self):
        self.issue('codex')
        foreign = self.child_body('codex')
        foreign['model'] = PARENT_MODELS['cursor']
        self.reject('cursor', foreign, 'native Task child provider mismatch')
        wrong_model = self.child_body('codex')
        wrong_model['model'] = 'mock-alpha'  # Valid Codex model, but not the recorded parent model.
        self.reject('codex', wrong_model, 'native Task child model mismatch')
        self.assertEqual(self.bridge.native_tasks['codex']['child_calls'], 0)
        self.assertEqual(self.bridge.native_tasks['cursor']['child_calls'], 0)

    def test_parent_provider_and_model_must_match_invocation(self):
        foreign = self.parent_body('codex')
        foreign['model'] = PARENT_MODELS['cursor']
        self.reject('cursor', foreign, 'native Task parent provider mismatch')
        self.issue('codex')
        wrong = self.parent_body('codex')
        wrong['model'] = 'mock-alpha'
        self.reject('codex', wrong, 'native Task parent model changed')

    def test_absent_ambiguous_and_incompatible_wire_schemas_fail_closed(self):
        variants = []
        body = self.parent_body()
        body['tools'] = []
        variants.append((body, 'native spawn_subagent tool absent or ambiguous'))
        body = self.parent_body()
        body['tools'] *= 2
        variants.append((body, 'native spawn_subagent tool absent or ambiguous'))
        body = self.parent_body()
        body['tools'][0]['function']['parameters']['required'].append('model')
        variants.append((body, 'unsupported required native Task argument'))
        body = self.parent_body()
        schema = body['tools'][0]['function']['parameters']
        schema['properties']['run_in_background'] = schema['properties'].pop('background')
        schema['required'].remove('background')
        variants.append((body, 'unsupported supplied native Task argument'))
        for body, error in variants:
            self.reject('codex', body, error)
            self.assertFalse(self.bridge.native_tasks['codex']['issued'])
            self.assertIsNone(self.bridge.native_tasks['codex']['expected_model'])

    def test_both_children_roundtrip_correlated_nonce_with_parent_history_preserved(self):
        prior = []
        for provider in PARENT_MODELS:
            with self.subTest(provider=provider):
                body = self.parent_body(provider)
                body['messages'] = copy.deepcopy(prior) + body['messages']
                body, call = self.issue(provider, body)
                nonce = self.child(provider, blocks=True)
                result = self.result_body(body, call, 'Native child result:\n' + nonce)
                chunks = self.sse(provider, result)
                self.assertIn(TASK_MARKERS[provider], json.dumps(chunks))
                state = self.bridge.snapshot()['native_tasks'][provider]
                self.assertEqual((state['provider'], state['expected_model'], state['child_provider'],
                                  state['child_model'], state['child_calls'], state['verified']),
                                 (provider, PARENT_MODELS[provider], provider, PARENT_MODELS[provider], 1, True))
                # Parent history contains markers in assistant call arguments; it
                # must still route as interactive, never another child request.
                self.assertEqual(self.bridge.snapshot()['requests'][-1]['purpose'], 'interactive')
                self.assertNotIn(nonce, json.dumps(self.bridge.snapshot()))
                prior = result['messages'] + [{'role': 'assistant', 'content': TASK_MARKERS[provider]}]
        snapshot = self.bridge.snapshot()
        self.assertEqual([e['provider'] for e in snapshot['events'] if e['kind'] == 'child_chat'], ['codex', 'cursor'])
        self.assertEqual([e['case'] for e in snapshot['events'] if e['kind'] == 'chat'],
                         ['task_codex', 'task_codex', 'task_cursor', 'task_cursor'])
        self.assertEqual(sum(r.get('purpose') == 'subagent' for r in snapshot['requests']), 2)
        self.assertNotEqual(self.bridge.native_tasks['codex']['nonce'], self.bridge.native_tasks['cursor']['nonce'])

    def test_missing_wrong_or_metadata_only_nonce_cannot_verify(self):
        body, call = self.issue()
        nonce = self.child()
        for content in (None, 'permission denied', self.bridge.native_tasks['cursor']['nonce']):
            with self.subTest(content_kind=type(content).__name__):
                result = self.result_body(body, call, content)
                # Presence elsewhere in history or result metadata is not proof.
                result['messages'][0]['content'] += '\nHistorical text: ' + nonce
                result['messages'][-1]['metadata'] = nonce
                self.reject('codex', result, 'native Task result lacks child nonce')
                self.assertFalse(self.bridge.native_tasks['codex']['verified'])

    def test_nonce_without_observed_child_cannot_verify(self):
        body, call = self.issue()
        result = self.result_body(body, call, self.bridge.native_tasks['codex']['nonce'])
        self.reject('codex', result, 'native Task result lacks one observed child request')
        self.assertFalse(self.bridge.native_tasks['codex']['verified'])

    def test_tool_result_requires_exact_preceding_correlated_call(self):
        body, call = self.issue()
        nonce = self.child()
        correct = self.result_body(body, call, nonce)
        variants = []
        result = copy.deepcopy(correct)
        del result['messages'][-2]
        variants.append((result, 'native Task requires one correlated assistant call'))
        result = copy.deepcopy(correct)
        result['messages'][-2]['tool_calls'][0]['id'] = 'uncorrelated-call'
        variants.append((result, 'native Task requires one correlated assistant call'))
        result = copy.deepcopy(correct)
        result['messages'][-1]['tool_call_id'] = 'uncorrelated-result'
        variants.append((result, 'native Task requires one correlated tool result'))
        result = copy.deepcopy(correct)
        result['messages'][-2]['tool_calls'][0]['function']['name'] = 'Task'
        variants.append((result, 'native Task correlated tool name mismatch'))
        result = copy.deepcopy(correct)
        result['messages'][-2]['tool_calls'][0]['function']['arguments'] = '{}'
        variants.append((result, 'native Task correlated arguments changed'))
        result = copy.deepcopy(correct)
        result['messages'][-2]['tool_calls'][0]['function']['arguments'] = 'not JSON'
        variants.append((result, 'native Task correlated arguments invalid'))
        result = copy.deepcopy(correct)
        result['messages'][-1], result['messages'][-2] = result['messages'][-2], result['messages'][-1]
        variants.append((result, 'native Task call/result order mismatch'))
        result = copy.deepcopy(correct)
        result['messages'].append({'role': 'user', 'content': PROMPTS['task_codex']})
        variants.append((result, 'native Task call/result order mismatch'))
        result = copy.deepcopy(correct)
        result['messages'].insert(-1, {'role': 'assistant', 'tool_calls': [{'id': 'different-call'}]})
        variants.append((result, 'native Task result follows a different assistant call'))
        result = copy.deepcopy(correct)
        result['messages'][-2]['tool_calls'].append(copy.deepcopy(call))
        variants.append((result, 'native Task requires one correlated assistant call'))
        result = copy.deepcopy(correct)
        result['messages'].append(copy.deepcopy(result['messages'][-1]))
        variants.append((result, 'native Task requires one correlated tool result'))
        for result, error in variants:
            with self.subTest(error=error):
                self.reject('codex', result, error)
                self.assertFalse(self.bridge.native_tasks['codex']['verified'])

    def test_duplicate_parent_invocation_and_completion_are_rejected(self):
        body, call = self.issue()
        self.reject('codex', body, 'native Task requires one correlated tool result')
        result = self.result_body(body, call, self.child())
        self.sse('codex', result)
        self.reject('codex', result, 'duplicate native Task parent completion')
        self.assertEqual(sum(e['kind'] == 'task_issued' for e in self.bridge.snapshot()['events']), 1)

    def test_duplicate_child_does_not_get_a_second_response(self):
        self.issue()
        self.child()
        self.reject('codex', self.child_body(), 'duplicate native Task child request')
        self.assertEqual(self.bridge.native_tasks['codex']['child_calls'], 1)

    def test_nonce_leaked_before_parent_invocation_is_rejected(self):
        for provider in PARENT_MODELS:
            body = self.parent_body(provider)
            body['messages'][0]['content'] += '\n' + self.bridge.native_tasks[provider]['nonce']
            self.reject(provider, body, 'child nonce leaked before parent invocation')
            self.assertFalse(self.bridge.native_tasks[provider]['issued'])

    def test_nonce_leaked_before_child_response_is_rejected(self):
        self.issue()
        body = self.child_body()
        body['messages'][0]['content'] += '\n' + self.bridge.native_tasks['codex']['nonce']
        self.reject('codex', body, 'child nonce leaked before child response')
        self.assertEqual(self.bridge.native_tasks['codex']['child_calls'], 0)

    def test_extra_uncorrelated_call_or_result_cannot_verify(self):
        body, call = self.issue()
        nonce = self.child()
        for extra in ('call', 'result'):
            result = self.result_body(body, call, nonce)
            if extra == 'call':
                foreign = copy.deepcopy(call)
                foreign['id'] = 'uncorrelated-extra-call'
                result['messages'][-2]['tool_calls'].append(foreign)
            else:
                result['messages'].append({'role': 'tool', 'tool_call_id': 'uncorrelated-extra-call', 'content': nonce})
            self.reject('codex', result, 'uncorrelated extra native Task call or result')
            self.assertFalse(self.bridge.native_tasks['codex']['verified'])

    def test_unsolicited_initial_task_call_or_result_is_rejected(self):
        for message in ({'role': 'assistant', 'tool_calls': [{'id': TASK_CALL_IDS['codex']}]},
                        {'role': 'tool', 'tool_call_id': TASK_CALL_IDS['codex'], 'content': 'fake'},
                        {'role': 'assistant', 'tool_calls': [{'id': 'foreign-call', 'function': {'name': 'spawn_subagent'}}]},
                        {'role': 'tool', 'tool_call_id': 'foreign-call', 'content': 'fake'}):
            body = self.parent_body()
            body['messages'].append(message)
            self.reject('codex', body, 'unsolicited native Task call or result')
            self.assertFalse(self.bridge.native_tasks['codex']['issued'])

    def test_auxiliary_routing_precedes_child_detection(self):
        for provider in PARENT_MODELS:
            previous = {'role': 'user', 'content': CHILD_MARKERS[provider]}
            variants = [
                ('title_function', {'messages': [previous], 'tools': [{'type': 'function', 'function': {'name': 'session_title'}}], 'tool_choice': {'type': 'function', 'function': {'name': 'session_title'}}}),
                ('prediction', {'messages': [{'role': 'system', 'content': 'You predict the next line the USER will type into their coding agent.'}, previous]}),
                ('title', {'messages': [{'role': 'user', 'content': '<system-reminder>Generate a session title for the conversation above. ' + CHILD_MARKERS[provider]}]}),
                ('dashboard', {'messages': [{'role': 'user', 'content': "<system-reminder>Write an ultra-short dashboard line that captures the AGENT'S REPLY " + CHILD_MARKERS[provider]}], 'tools': TASK_TOOLS}),
            ]
            for kind, fields in variants:
                self.sse(provider, {'model': PARENT_MODELS[provider], 'stream': True, **fields})
                snapshot = self.bridge.snapshot()
                self.assertEqual(snapshot['requests'][-1]['purpose'], 'auxiliary')
                self.assertEqual((snapshot['events'][-1]['kind'], snapshot['events'][-1]['case']), ('auxiliary', kind))
                self.assertFalse(snapshot['native_tasks'][provider]['issued'])
                self.assertEqual(snapshot['native_tasks'][provider]['child_calls'], 0)
        self.assertFalse(any(e['kind'] in ('chat', 'child_chat') for e in self.bridge.snapshot()['events']))

    def test_unknown_last_user_does_not_match_markers_in_serialized_history(self):
        body = self.child_body()
        body['messages'].extend([{'role': 'assistant', 'content': PROMPTS['task_codex']},
                                 {'role': 'user', 'content': 'Unrecognized request; never accept this.'}])
        self.reject('codex', body, 'unexpected model prompt (background sampler?)')
        body = self.child_body()
        body['messages'][0]['content'] += '\n' + CHILD_MARKERS['cursor']
        self.reject('codex', body, 'ambiguous native Task child marker')
        self.assertFalse(any(s['issued'] for s in self.bridge.native_tasks.values()))


class ResumeTests(unittest.TestCase):
    # Share fixture helpers, not inherited test methods.
    setUp, tearDown = TaskTests.setUp, TaskTests.tearDown
    request, json, sse = TaskTests.request, TaskTests.json, TaskTests.sse
    parent_body, child_body = TaskTests.parent_body, TaskTests.child_body
    issue, child, reject = TaskTests.issue, TaskTests.child, TaskTests.reject
    result_body = TaskTests.result_body

    def test_resume_inherits_model_and_full_child_history_on_both_providers(self):
        for provider in PARENT_MODELS:
            original, call = self.issue(provider)
            nonce = self.child(provider)
            original_result = self.result_body(original, call, nonce)
            self.sse(provider, original_result)
            body = copy.deepcopy(original_result)
            body['messages'] += [{'role': 'assistant', 'content': TASK_MARKERS[provider]},
                                 {'role': 'user', 'content': PROMPTS['resume_' + provider]}]
            chunks = self.sse(provider, body)
            resumed_call = next(c['choices'][0]['delta']['tool_calls'][0] for c in chunks if 'tool_calls' in c['choices'][0]['delta'])
            resumed_call.pop('index')
            arguments = json.loads(resumed_call['function']['arguments'])
            self.assertEqual(set(arguments), {'prompt', 'description', 'subagent_type', 'background', 'resume_from'})
            self.assertEqual(arguments['resume_from'], self.bridge.native_tasks[provider]['subagent_id'])
            self.assertEqual(arguments['subagent_type'], 'general-purpose')
            self.assertIs(arguments['background'], False)
            resumed_nonce = self.bridge.native_resumes[provider]['nonce']
            self.assertNotIn(resumed_nonce, json.dumps(body))
            self.assertNotIn(resumed_nonce, json.dumps(resumed_call))
            child = self.child_body(provider)
            child['messages'] += [{'role': 'assistant', 'content': nonce},
                                  {'role': 'user', 'content': arguments['prompt']}]
            wrong = copy.deepcopy(child)
            wrong['messages'].pop(1)
            self.reject(provider, wrong, 'resumed child lost original assistant history')
            wrong = copy.deepcopy(child)
            wrong['messages'].pop(0)
            self.reject(provider, wrong, 'resumed child lost original user history')
            wrong = copy.deepcopy(child)
            wrong['messages'][-1]['content'] += resumed_nonce
            self.reject(provider, wrong, 'child nonce leaked before child response')
            if provider == 'codex':
                wrong = copy.deepcopy(child)
                wrong['model'] = 'mock-alpha'
                self.reject(provider, wrong, 'native Task child model mismatch')
            self.assertIn(resumed_nonce, json.dumps(self.sse(provider, child)))
            self.reject(provider, child, 'duplicate native Task child request')
            result = self.result_body(body, resumed_call, resumed_nonce)
            wrong = copy.deepcopy(result)
            wrong['messages'][-1]['tool_call_id'] = 'wrong-resume-call'
            self.reject(provider, wrong, 'native Task requires one correlated tool result')
            wrong = copy.deepcopy(result)
            wrong['messages'][-1]['content'] = nonce + footer('new-run-id')
            self.reject(provider, wrong, 'native Task result lacks child nonce')
            self.assertIn(RESUME_MARKERS[provider], json.dumps(self.sse(provider, result)))
            state = self.bridge.snapshot()['native_resumes'][provider]
            self.assertTrue(state['verified'] and state['history_verified'])
            self.assertEqual(state['child_calls'], 1)
            self.assertEqual((state['child_provider'], state['child_model']), (provider, PARENT_MODELS[provider]))
            self.assertNotEqual(state['subagent_id'], arguments['resume_from'])
            self.assertNotIn(resumed_nonce, json.dumps(self.bridge.snapshot()))

    def test_resume_rejects_missing_prior_child_and_wrong_provider(self):
        body = self.parent_body()
        body['messages'][0]['content'] = PROMPTS['resume_codex']
        self.reject('codex', body, 'resume requires verified original child ID')
        body['model'] = PARENT_MODELS['cursor']
        self.reject('cursor', body, 'native Task parent provider mismatch')


class TaskOptInTests(unittest.TestCase):
    def test_returned_id_requires_exact_unique_typed_footer(self):
        self.assertEqual(returned_subagent_id('answer' + footer('actual-id')), 'actual-id')
        for value in ('subagent_id: invented', footer() * 2, footer().replace('general-purpose', 'Explore'),
                      footer().replace('resume_from="observed-child-id"', 'resume_from="wrong"')):
            with self.assertRaises(AssertionError):
                returned_subagent_id(value)

    def test_approval_waits_heading_and_sends_only_exact_single_use_digit(self):
        from types import SimpleNamespace
        screen = 'Allow Native codex Task probe?\n1 (●) Yes, and do not ask again\n2 (○) Always allow\n3 (○) Yes'
        state = {'issued': True, 'child_calls': 0, 'verified': False}
        seen = []
        terminal = SimpleNamespace(screen=SimpleNamespace(text=lambda: screen),
                                   wait=lambda predicate, description: self.assertTrue(predicate()),
                                   pump=lambda seconds: None, send=seen.append)
        permissions = []
        bridge = SimpleNamespace(snapshot=lambda: {'native_tasks': {'codex': state}},
                                 event=lambda kind, **data: permissions.append({'kind': kind, **data}))
        native_pty.approve_task_once(terminal, bridge, 'codex')
        self.assertEqual(permissions, [{'kind': 'task_permission', 'provider': 'codex', 'resume': False,
                                       'pending_child_requests': 0, 'label': 'Yes', 'key': '3'}])
        self.assertEqual(seen, [b'3'])
        seen.clear()
        state['child_calls'] = 1
        with self.assertRaisesRegex(AssertionError, 'while approval pending'):
            native_pty.approve_task_once(terminal, bridge, 'codex')
        self.assertEqual(seen, [])
        state['child_calls'] = 0
        screen = screen.replace('Allow Native codex Task probe?', 'Allow Native cursor Task probe?')
        with self.assertRaises(AssertionError):
            native_pty.approve_task_once(terminal, bridge, 'codex')
        self.assertEqual(seen, [])

    def test_scenario_tasks_default_off_and_cli_exposes_explicit_opt_in(self):
        self.assertIs(inspect.signature(native_pty.run_scenario).parameters['with_native_tasks'].default, False)
        output = io.StringIO()
        with patch('sys.argv', ['native_pty.py', '--help']), redirect_stdout(output), \
             patch('native_pty.Terminal') as terminal, patch('native_pty.MockBridge') as bridge:
            with self.assertRaises(SystemExit) as exit_status:
                native_pty.main()
        self.assertEqual(exit_status.exception.code, 0)
        self.assertIn('--with-native-tasks', output.getvalue())
        terminal.assert_not_called()
        bridge.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)

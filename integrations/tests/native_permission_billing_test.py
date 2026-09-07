#!/usr/bin/env python3
"""Unit/preflight controls only; passing these never means vendor acceptance."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from native_billing_fixture import BillingFixture, DENIAL, correlated_result, scripted_reply
from native_permission_billing import (BILLING_ALLOW, BILLING_DENY, Blocked, TOOL_DENY, choose_tool,
                                       live_gates, native_config, permission_key, question_index)


class PermissionBillingTests(unittest.TestCase):
    def test_permission_exact_rows_never_blanket(self):
        screen = '  1 (●) Yes, allow all tools\n  2 (○) Yes, always allow this tool\n  3 (○) Yes\n  4 (○) No, reject (type to add feedback)\n'
        self.assertEqual(permission_key(screen, 'Yes'), b'3')
        self.assertEqual(permission_key(screen, TOOL_DENY), b'4')
        self.assertIsNone(permission_key(screen, 'allow once'))

    def test_refuse_first_permission_row(self):
        fake = SimpleNamespace(screen=SimpleNamespace(text=lambda: '  1 (○) Yes\n'), send=lambda _: self.fail('blanket sent'))
        with self.assertRaises(AssertionError):
            choose_tool(fake, 'Yes')

    def test_billing_exact_order(self):
        screen = '  1 (●) ' + BILLING_DENY + '     Do not call this native xAI service.\n  2 (○) ' + BILLING_ALLOW + '  Explicitly permit this service.\n'
        self.assertEqual(question_index(screen, BILLING_DENY), 0)
        self.assertEqual(question_index(screen, BILLING_ALLOW), 1)
        self.assertIsNone(question_index(screen, 'Allow'))

    def test_config_pins_both_catalog_bases_and_native_key_name(self):
        config = tomllib.loads(native_config('http://127.0.0.1:9999/native/v1', 'fixture'))
        entry = config['model']['native-billing-acceptance']
        self.assertEqual(entry['base_url'], entry['api_base_url'])
        self.assertEqual(config['endpoints']['xai_api_base_url'], entry['base_url'])
        self.assertEqual(entry['env_key'], 'XAI_API_KEY')
        self.assertNotIn('api_key', entry)
        self.assertEqual(config['models']['web_search'], 'native-billing-acceptance')

    def tool_body(self, case, content):
        tool = 'use_tool' if case.startswith('tool_') else 'web_search'
        call_id = case + '-call'
        return {'messages': [
            {'role': 'assistant', 'tool_calls': [{'id': call_id, 'function': {'name': tool}}]},
            {'role': 'tool', 'tool_call_id': call_id, 'content': content}]}

    def test_reject_unsolicited_and_duplicate_result(self):
        body = self.tool_body('tool_deny', 'denied')
        body['messages'].pop(0)
        with self.assertRaises(AssertionError):
            correlated_result(body, 'tool_deny-call', 'use_tool')
        body = self.tool_body('tool_deny', 'denied')
        body['messages'].append(body['messages'][-1])
        with self.assertRaises(AssertionError):
            correlated_result(body, 'tool_deny-call', 'use_tool')

    def test_billing_denial_requires_specific_policy_error(self):
        for error in ('401 Unauthorized', 'unknown model', 'no API key', 'offline', 'cancelled'):
            with self.subTest(error=error), self.assertRaises(AssertionError):
                scripted_reply(self.tool_body('billing_deny', error), 'billing_deny', 'mcpnonce', 'responsenonce', [])
        events = []
        delta, finish = scripted_reply(self.tool_body('billing_deny', DENIAL), 'billing_deny', 'mcpnonce', 'responsenonce', events)
        self.assertTrue(events[0]['explicit_billing_denial'])
        self.assertEqual(finish, 'stop')
        self.assertIn('CONTINUED', delta['content'])

    def test_tool_denial_not_cancel_or_success(self):
        for result in ('cancelled by user', 'success', 'denied mcpnonce'):
            with self.subTest(result=result), self.assertRaises(AssertionError):
                scripted_reply(self.tool_body('tool_deny', result), 'tool_deny', 'mcpnonce', 'responsenonce', [])

    def test_allow_requires_private_tool_result(self):
        for case, nonce in [('tool_allow_once', 'mcpnonce'), ('billing_allow', 'responsenonce')]:
            with self.subTest(case=case):
                with self.assertRaises(AssertionError):
                    scripted_reply(self.tool_body(case, 'fabricated'), case, 'mcpnonce', 'responsenonce', [])
                self.assertEqual(scripted_reply(self.tool_body(case, nonce), case, 'mcpnonce', 'responsenonce', [])[1], 'stop')

    def test_mcp_side_effect_only_at_tools_call(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            nonce, receipts = root / 'nonce', root / 'receipts'
            nonce.write_text('private-unit-nonce')
            command = [sys.executable, '-B', str(Path(__file__).with_name('native_billing_mcp.py')), str(nonce), str(receipts)]
            before = [{'id': 1, 'method': 'initialize', 'params': {}}, {'id': 2, 'method': 'tools/list'}]
            process = subprocess.run(command, input=''.join(json.dumps(r) + '\n' for r in before), text=True, capture_output=True, check=True, timeout=5)
            self.assertFalse(receipts.exists())
            self.assertNotIn('private-unit-nonce', process.stdout)
            call = {'id': 3, 'method': 'tools/call', 'params': {'name': 'probe', 'arguments': {}}}
            process = subprocess.run(command, input=json.dumps(call) + '\n', text=True, capture_output=True, check=True, timeout=5)
            self.assertIn('private-unit-nonce', process.stdout)
            self.assertEqual(len(receipts.read_text().splitlines()), 1)

    def test_native_sink_positive_control_request_bound_attribution(self):
        with tempfile.TemporaryDirectory() as temp, BillingFixture(Path(temp), 'nonce') as bridge:
            bridge.approved = True
            body = {'model': 'native-billing-fixture', 'tools': [{'type': 'web_search'}], 'store': False, 'max_output_tokens': 8192}
            request = Request(bridge.native_base + '/responses', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + bridge.native_key})
            with urlopen(request, timeout=5) as response:
                self.assertIn(bridge.native_nonce, response.read().decode())
            self.assertEqual(bridge.native_requests[0]['credential_source'], 'synthetic-native-env')
            self.assertNotIn(bridge.native_key, json.dumps(bridge.native_requests))

    def test_catalog_discovery_is_not_a_billable_dispatch(self):
        with tempfile.TemporaryDirectory() as temp, BillingFixture(Path(temp), 'nonce') as bridge:
            request = Request(bridge.native_base + '/models', headers={'Authorization': 'Bearer ' + bridge.native_key})
            with urlopen(request, timeout=5) as response:
                self.assertEqual(response.status, 200)
            self.assertEqual(len(bridge.catalog_requests), 1)
            self.assertEqual(bridge.native_requests, [])
            self.assertEqual(bridge.errors, [])

    def test_native_sink_detects_premature_dispatch(self):
        with tempfile.TemporaryDirectory() as temp, BillingFixture(Path(temp), 'nonce') as bridge:
            request = Request(bridge.native_base + '/responses', data=b'{}', headers={'Authorization': 'Bearer ' + bridge.native_key})
            with self.assertRaises(HTTPError) as caught:
                urlopen(request, timeout=5)
            caught.exception.close()
            self.assertEqual(len(bridge.native_requests), 1)
            self.assertFalse(bridge.native_requests[0]['after_explicit_ui_allow'])
            self.assertTrue(bridge.errors)

    def test_live_requires_parent_grants_and_native_observer(self):
        args = SimpleNamespace(credentials_ready=False, allow_subscription_usage=False, case='billing_allow',
                               allow_native_paid_usage=False, budget_usd=None, ack_no_hard_dollar_cap=False, auth_directory=None)
        with self.assertRaisesRegex(Blocked, 'subscription'):
            live_gates(args)
        args.credentials_ready = args.allow_subscription_usage = True
        with self.assertRaisesRegex(Blocked, 'budget'):
            live_gates(args)
        args.allow_native_paid_usage = args.ack_no_hard_dollar_cap = True
        for budget in (0, -1, float('nan'), float('inf')):
            args.budget_usd = budget
            with self.subTest(budget=budget), self.assertRaisesRegex(Blocked, 'budget'):
                live_gates(args)
        args.budget_usd = 1
        with self.assertRaisesRegex(Blocked, 'observer'):
            live_gates(args)


if __name__ == '__main__':
    unittest.main()

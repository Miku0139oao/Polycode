#!/usr/bin/env python3
"""Unit/contract tests only. Passing these is NOT native-binary acceptance."""
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote

from native_mock import CALL_ID, MODELS, PROMPTS, STREAM_MARKER, TOOL_MARKER, MockBridge, read_tool
from native_pty import Screen, Terminal, isolated_environment, native_preflight, require_network_isolation
from native_live import official_login, open_official_browser

TOOLS = [{'type': 'function', 'function': {'name': 'Read', 'parameters': {
    'type': 'object', 'properties': {'file_path': {'type': 'string'}}, 'required': ['file_path']}}}]


class LiveSafetyTests(unittest.TestCase):
    def test_official_browser_destination_is_exact(self):
        self.assertEqual(official_login('https://auth.openai.com/oauth/authorize?state=fixture', 'codex'), 'https://auth.openai.com/oauth/authorize?state=fixture')
        self.assertEqual(official_login('https://cursor.com/loginDeepControl?uuid=fixture', 'cursor'), 'https://cursor.com/loginDeepControl?uuid=fixture')
        for url in ['http://auth.openai.com/oauth/authorize', 'https://auth.openai.com.evil.test/oauth/authorize', 'https://user@auth.openai.com/oauth/authorize', 'file:///tmp/code', 'https://auth.openai.com/not-oauth']:
            with self.assertRaises(ValueError):
                official_login(url, 'codex')

    def test_public_url_is_quoted_as_data_not_shell_code(self):
        import base64
        url = "https://auth.openai.com/oauth/authorize?state=x';Write-Output=bad"
        with patch('native_live.subprocess.run') as run:
            open_official_browser(url, 'codex')
        argv = run.call_args.args[0]
        self.assertNotIn('cmd.exe', argv[0])
        script = base64.b64decode(argv[-1]).decode('utf-16le')
        self.assertEqual(script, "Start-Process -FilePath '" + url.replace("'", "''") + "'")


class CompiledCaseRunnerTests(unittest.TestCase):
    def test_exact_case_result_and_separate_error_capture(self):
        from native_rust_cases import run_case
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'fake-test'
            executable.write_text("#!/usr/bin/python3\nimport sys\ncase=sys.argv[1]\nif case=='panic':\n print('fixture panic detail',file=sys.stderr)\n sys.exit(101)\nprint('test result: ok. '+('0' if case=='missing' else '1')+' passed; 0 failed; 0 ignored;')\n")
            executable.chmod(0o700)
            good = run_case(executable, root, 'good', root / 'good', 5, 33554432)
            missing = run_case(executable, root, 'missing', root / 'missing', 5, 33554432)
            panic = run_case(executable, root, 'panic', root / 'panic', 5, 33554432)
            self.assertTrue(good['passed'])
            self.assertFalse(missing['passed'], 'zero matched tests must never pass')
            self.assertFalse(panic['passed'])
            self.assertIn('fixture panic detail', Path(panic['stderr']).read_text())
            self.assertNotIn('fixture panic detail', Path(panic['stdout']).read_text())
            self.assertEqual(good['cwd'], str(root))

    def test_timeout_is_failure_not_a_skipped_test(self):
        from native_rust_cases import run_case
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'fake-test'
            executable.write_text('#!/usr/bin/python3\nimport time\ntime.sleep(10)\n')
            executable.chmod(0o700)
            result = run_case(executable, root, 'slow', root / 'slow', .1, 33554432)
            self.assertTrue(result['timed_out'])
            self.assertFalse(result['passed'])


class McpFixtureTests(unittest.TestCase):
    def test_stdio_protocol_and_private_environment_evidence(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / 'value.txt'
            fixture.write_text('mcp-private-fixture-value\n')
            requests = [
                {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05'}},
                {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'probe', 'arguments': {}}},
            ]
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('native_mcp_fixture.py')), str(fixture), str(root / 'env.jsonl'), str(root / 'calls.jsonl')], input='\n'.join(map(json.dumps, requests)) + '\n', text=True, capture_output=True, check=True, timeout=10, env={'PATH': '/usr/bin:/bin', 'HOME': directory})
            replies = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual([r['id'] for r in replies], [1, 2, 3])
            self.assertEqual(replies[1]['result']['tools'][0]['name'], 'probe')
            self.assertEqual(replies[2]['result']['content'][0]['text'], fixture.read_text())
            self.assertEqual((root / 'env.jsonl').stat().st_mode & 0o777, 0o600)
            self.assertNotIn('POLYCODE_BRIDGE_TOKEN', (root / 'env.jsonl').read_text())


class MockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = Path(self.temp.name) / 'fixture.txt'
        self.fixture.write_text('random-private-fixture-value\n')
        self.bridge = MockBridge(self.fixture, 'random-private-fixture-value').start()
        self.connections = []
        self.expected_errors = []

    def tearDown(self):
        for connection in self.connections:
            connection.close()
        self.bridge.close()
        self.temp.cleanup()
        self.assertEqual(self.bridge.snapshot()['errors'], self.expected_errors, 'asynchronous mock server error')

    def request(self, method, path, body=None, token=True, trap=False):
        server = self.bridge.trap if trap else self.bridge.server
        conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=4)
        self.connections.append(conn)
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + self.bridge.token
        conn.request(method, path, json.dumps(body) if body is not None else None, headers)
        return conn.getresponse()

    def json(self, method, path, body=None, **kwargs):
        response = self.request(method, path, body, **kwargs)
        return response.status, json.loads(response.read())

    def start_login(self, provider='codex'):
        status, data = self.json('POST', '/control/login/start', {'provider': provider})
        self.assertEqual(status, 200)
        self.assertNotIn(self.bridge.token, json.dumps(data))
        return data['attemptId']

    def chat_body(self, case, messages=None):
        return {'model': 'mock-alpha', 'stream': True, 'tools': TOOLS,
                'messages': messages or [{'role': 'user', 'content': PROMPTS[case]}]}

    def sse(self, body):
        self.bridge.logged_in['codex'] = True
        response = self.request('POST', '/codex/v1/chat/completions', body)
        self.assertEqual(response.status, 200)
        wire = response.read().decode()
        self.assertTrue(wire.endswith('data: [DONE]\n\n'))
        return [json.loads(line[6:]) for line in wire.splitlines()
                if line.startswith('data: ') and line != 'data: [DONE]']

    def test_signed_out_catalog_and_authentication(self):
        status, data = self.json('GET', '/control/catalog')
        self.assertEqual(status, 200)
        self.assertEqual([p['id'] for p in data['providers']], ['codex', 'cursor'])
        self.assertTrue(all(not p['loggedIn'] and not p['models'] for p in data['providers']))
        status, _ = self.json('GET', '/control/catalog', token=False)
        self.assertEqual(status, 401)
        for path in ('/control/refresh', '/control/login/start', '/control/login/cancel', '/codex/v1/chat/completions', '/cursor/v1/chat/completions'):
            self.assertEqual(self.json('POST', path, {}, token=False)[0], 401)
        self.assertEqual(self.json('GET', '/control/login/status?attemptId=x', token=False)[0], 401)

    def test_bare_origin_probe_is_rejected_and_status_recorded(self):
        self.assertEqual(self.json('GET', '/', token=False)[0], 401)
        request = self.bridge.snapshot()['requests'][-1]
        self.assertFalse(request['authenticated'])
        self.assertEqual(request['status'], 401)

    def test_native_auxiliary_calls_do_not_impersonate_interactive_turns(self):
        previous = {'role': 'user', 'content': PROMPTS['stream']}
        bodies = [
            ('title_function', {'messages': [previous], 'tools': [{'type': 'function', 'function': {'name': 'session_title'}}], 'tool_choice': {'type': 'function', 'function': {'name': 'session_title'}}}),
            ('prediction', {'messages': [{'role': 'system', 'content': 'You predict the next line the USER will type into their coding agent.'}, previous]}),
            ('title', {'messages': [previous, {'role': 'user', 'content': '<system-reminder>Generate a session title for the conversation above.'}]}),
            ('dashboard', {'messages': [previous, {'role': 'user', 'content': "<system-reminder>Write an ultra-short dashboard line that captures the AGENT'S REPLY"}], 'tools': TOOLS}),
        ]
        for kind, fields in bodies:
            with self.subTest(kind=kind):
                chunks = self.sse({'model': 'mock-alpha', 'stream': True, **fields})
                self.assertNotIn(STREAM_MARKER, json.dumps(chunks))
                self.assertFalse(self.bridge.stream_started.is_set())
                event = self.bridge.snapshot()['events'][-1]
                self.assertEqual((event['kind'], event['case']), ('auxiliary', kind))
                self.assertEqual(self.bridge.snapshot()['requests'][-1]['purpose'], 'auxiliary')
                if kind == 'title_function':
                    calls = [c for chunk in chunks for c in chunk['choices'][0]['delta'].get('tool_calls', [])]
                    self.assertEqual(calls[0]['function']['name'], 'session_title')
                    self.assertIn('session_title', json.loads(calls[0]['function']['arguments']))

    def test_mcp_discovery_and_correlated_native_dispatch(self):
        self.bridge.mcp_value = 'mcp-distinct-fixture-value'
        messages = [{'role': 'user', 'content': PROMPTS['mcp']}]
        tools = [{'type': 'function', 'function': {'name': name}} for name in ('search_tool', 'use_tool')]
        for name, output in [('search_tool', 'fixture__probe schema'), ('use_tool', self.bridge.mcp_value)]:
            chunks = self.sse({'model': 'mock-alpha', 'stream': True, 'messages': messages, 'tools': tools})
            call = next(chunk['choices'][0]['delta']['tool_calls'][0] for chunk in chunks if 'tool_calls' in chunk['choices'][0]['delta'])
            self.assertEqual(call['function']['name'], name)
            messages.extend([{'role': 'assistant', 'tool_calls': [call]}, {'role': 'tool', 'tool_call_id': call['id'], 'content': output}])
        chunks = self.sse({'model': 'mock-alpha', 'stream': True, 'messages': messages, 'tools': tools})
        self.assertIn('NATIVE_MCP_ROUNDTRIP_OK', json.dumps(chunks))
        self.assertTrue(self.bridge.mcp_verified)

    def test_login_poll_refresh_and_exact_encoded_attempt_id(self):
        attempt = self.start_login()
        path = '/control/login/status?attemptId=' + quote(attempt, safe='')
        self.assertIn('%2F%3F%26', path)
        self.assertEqual(self.json('GET', path), (200, {'state': 'pending'}))
        self.bridge.complete_login(attempt)
        self.assertEqual(self.json('GET', path), (200, {'state': 'completed'}))
        status, data = self.json('POST', '/control/refresh', {})
        self.assertEqual(status, 200)
        self.assertTrue(data['providers'][0]['loggedIn'])
        self.assertEqual([m['id'] for m in data['providers'][0]['models']], [m[0] for m in MODELS['codex']])
        self.assertFalse(data['providers'][1]['loggedIn'])

    def test_cancel_is_terminal_and_preserves_signed_out_state(self):
        attempt = self.start_login('cursor')
        self.assertEqual(self.json('POST', '/control/login/cancel', {'attemptId': attempt}), (200, {}))
        path = '/control/login/status?attemptId=' + quote(attempt, safe='')
        self.assertEqual(self.json('GET', path), (200, {'state': 'cancelled'}))
        self.assertFalse(self.bridge.logged_in['cursor'])
        with self.assertRaises(AssertionError):
            self.bridge.complete_login(attempt)
        self.assertEqual(self.json('POST', '/control/login/cancel', {'attemptId': attempt})[0], 200)

    def test_failed_login_state(self):
        attempt = self.start_login()
        self.bridge.attempts[attempt]['state'] = 'failed'
        self.assertEqual(self.json('GET', '/control/login/status?attemptId=' + quote(attempt, safe=''))[1], {'state': 'failed'})

    def test_control_and_model_redirect_trap_positive_control(self):
        self.bridge.refresh_redirect = True
        response = self.request('POST', '/control/refresh', {})
        self.assertEqual(response.status, 307)
        self.assertEqual(response.getheader('Location'), self.bridge.trap_url + '/credential-trap')
        response.read()
        self.bridge.logged_in['codex'] = True
        response = self.request('POST', '/codex/v1/chat/completions', self.chat_body('redirect'))
        self.assertEqual(response.status, 307)
        response.read()
        self.assertEqual(self.bridge.snapshot()['trap_requests'], [])
        # Prove the detector fails closed if a client does leak the local credential.
        self.assertEqual(self.json('POST', '/credential-trap', {}, trap=True)[0], 418)
        self.assertTrue(self.bridge.snapshot()['trap_requests'][0]['secret_seen'])
        self.assertNotIn(self.bridge.token, json.dumps(self.bridge.snapshot()))

    def test_secret_in_body_or_query_rejected_and_redacted(self):
        self.assertEqual(self.json('POST', '/control/refresh', {'secret': self.bridge.token})[0], 401)
        self.assertEqual(self.json('GET', '/control/catalog?secret=' + self.bridge.token)[0], 401)
        self.assertNotIn(self.bridge.token, json.dumps(self.bridge.snapshot()))
        self.assertTrue(all(r['secret_elsewhere'] for r in self.bridge.snapshot()['requests']))

    def test_stream_is_held_until_driver_observes_rendered_prefix(self):
        self.bridge.logged_in['codex'] = True
        response = self.request('POST', '/codex/v1/chat/completions', self.chat_body('stream'))
        lines = []
        while not any(STREAM_MARKER in line for line in lines):
            lines.append(response.readline().decode())
        self.assertTrue(self.bridge.stream_started.wait(1))
        self.assertFalse(self.bridge.release_stream.is_set())
        self.bridge.release_stream.set()
        self.assertIn(b'NATIVE_STREAM_FINISHED', response.read())

    def test_tool_call_fragmentation_and_real_result_gate(self):
        chunks = self.sse(self.chat_body('tool'))
        deltas = [c['choices'][0]['delta'] for c in chunks]
        calls = [d['tool_calls'][0] for d in deltas if 'tool_calls' in d]
        self.assertEqual(calls[0]['id'], CALL_ID)
        self.assertNotIn('id', calls[1])
        arguments = ''.join(c['function']['arguments'] for c in calls)
        self.assertEqual(json.loads(arguments), {'file_path': str(self.fixture)})
        self.assertEqual(chunks[-1]['choices'][0]['finish_reason'], 'tool_calls')
        self.assertFalse(self.bridge.tool_verified)
        messages = [{'role': 'assistant', 'content': 'prior native response', 'tool_calls': None},
                    {'role': 'user', 'content': PROMPTS['tool']},
                    {'role': 'assistant', 'tool_calls': [{'id': CALL_ID, 'type': 'function',
                     'function': {'name': 'Read', 'arguments': arguments}}]},
                    {'role': 'tool', 'tool_call_id': CALL_ID, 'content': self.fixture.read_text()}]
        chunks = self.sse(self.chat_body('tool', messages))
        self.assertIn(TOOL_MARKER, json.dumps(chunks))
        self.assertTrue(self.bridge.tool_verified)
        self.assertEqual(self.bridge.snapshot()['errors'], [])

    def test_wrong_fixture_result_cannot_emit_success(self):
        self.sse(self.chat_body('tool'))
        messages = [{'role': 'user', 'content': PROMPTS['tool']},
                    {'role': 'assistant', 'tool_calls': [{'id': CALL_ID}]},
                    {'role': 'tool', 'tool_call_id': CALL_ID, 'content': 'permission denied'}]
        response = self.request('POST', '/codex/v1/chat/completions', self.chat_body('tool', messages))
        wire = response.read().decode()
        self.assertNotIn(TOOL_MARKER, wire)
        self.assertFalse(self.bridge.tool_verified)
        self.expected_errors = ['fixture bytes absent from native tool result']
        self.assertEqual(self.bridge.snapshot()['errors'], self.expected_errors)

    def test_block_content_and_wire_model_ids(self):
        body = self.chat_body('model', [{'role': 'user', 'content': [{'type': 'text', 'text': PROMPTS['model']}]}])
        self.assertIn('NATIVE_MODEL_OK', json.dumps(self.sse(body)))
        self.assertEqual(self.bridge.snapshot()['events'][-1]['model'], 'mock-alpha')

    def test_stream_disconnect_observable(self):
        self.bridge.logged_in['codex'] = True
        response = self.request('POST', '/codex/v1/chat/completions', self.chat_body('wait'))
        self.assertTrue(self.bridge.cancel_started.wait(1))
        response.close()
        self.connections[-1].close()
        self.assertTrue(self.bridge.cancel_disconnected.wait(3))


class HarnessTests(unittest.TestCase):
    def test_native_tool_schema_supported_and_unknown_required_rejected(self):
        definition, arguments = read_tool(TOOLS, '/tmp/fixture')
        self.assertEqual(definition['name'], 'Read')
        self.assertEqual(arguments, {'file_path': '/tmp/fixture'})
        tool = {'type': 'function', 'function': {'name': 'read_file', 'parameters': {
            'properties': {'target_file': {}, 'offset': {}, 'limit': {}},
            'required': ['target_file', 'offset', 'limit']}}}
        self.assertEqual(read_tool([tool], '/tmp/f')[1], {'target_file': '/tmp/f', 'offset': 1, 'limit': 20})
        tool['function']['parameters']['required'].append('unrecognized')
        with self.assertRaisesRegex(AssertionError, 'Unsupported required'):
            read_tool([tool], '/tmp/f')
        with self.assertRaisesRegex(AssertionError, 'No native Read'):
            read_tool([], '/tmp/f')

    def test_vt_incremental_utf8_cursor_paint_and_erase(self):
        screen = Screen(5, 40)
        wire = '\x1b[?1049h\x1b[2J\x1b[2;3HNATIVE_\x1b[31mSTREAM\x1b[0m_OK'.encode()
        for byte in wire:
            screen.feed(bytes([byte]))
        self.assertTrue(screen.alt_screen)
        self.assertIn('NATIVE_STREAM_OK', screen.text())
        screen.feed(b'\x1b[2;3H\x1b[2K')
        self.assertNotIn('NATIVE_STREAM_OK', screen.text())
        for byte in '模型\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\'.encode():
            screen.feed(bytes([byte]))
        self.assertIn('模型link', screen.text())
        self.assertNotIn('https://', screen.text())

    def test_environment_does_not_inherit_real_credentials_or_browser(self):
        with tempfile.TemporaryDirectory() as temp, MockBridge('/tmp/f', 'v') as bridge:
            with patch.dict(os.environ, {'XAI_API_KEY': 'real-key', 'DISPLAY': ':0',
                                        'HTTPS_PROXY': 'bad-proxy', 'BROWSER': 'real-browser'}):
                env = isolated_environment(Path(temp), bridge)
            for key in ('XAI_API_KEY', 'DISPLAY', 'WAYLAND_DISPLAY', 'BROWSER', 'HTTPS_PROXY', 'WSL_INTEROP'):
                self.assertNotIn(key, env)
            self.assertEqual(env['POLYCODE_BRIDGE_TOKEN'], bridge.token)
            self.assertEqual(env['GROK_TEST_OPEN_URL_FILE'], temp + '/browser-urls.txt')
            self.assertFalse(any(Path(env['GROK_HOME']).iterdir()))

    def test_network_safety_gate(self):
        with patch('native_pty.socket.if_nameindex', return_value=[(1, 'lo'), (2, 'eth0')]):
            with self.assertRaisesRegex(SystemExit, 'Refusing account/network access'):
                require_network_isolation()
        with patch('native_pty.socket.if_nameindex', return_value=[(1, 'lo')]):
            require_network_isolation()

    def test_old_binary_rejected_without_launching_fullscreen(self):
        with patch('native_pty.subprocess.run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b'--no-external-acp --acp-executable'
            with self.assertRaisesRegex(RuntimeError, 'NATIVE BINARY GATE'):
                native_preflight(Path('/not-a-native-binary'), {})
            self.assertEqual(run.call_count, 1)

    def test_actual_pty_discovery_fragmented_query_and_native_flag_detection(self):
        # A tiny fake terminal program tests PTY mechanics ONLY, never native acceptance.
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            script = path / 'child.py'
            script.write_text("import os, time, tty\n"
                              "tty.setraw(0)\n"
                              "os.write(1, b'\\x1b[?1049h\\x1b[')\n"
                              "time.sleep(.2)\n"
                              "os.write(1, b'6n')\n"
                              "reply = os.read(0, 20)\n"
                              "assert reply == b'\\x1b[1;1R', repr(reply)\n"
                              "os.write(1, b'\\x1b[3;2HPTY_MECHANICS_OK')\n"
                              "time.sleep(20)\n")
            terminal = Terminal([sys.executable, str(script)], {'PATH': '/usr/bin:/bin', 'TERM': 'xterm-256color'}, path)
            try:
                terminal.text('PTY_MECHANICS_OK', timeout=4)
                self.assertTrue(terminal.screen.alt_screen)
                terminal.alive()
            finally:
                terminal.close()
            self.assertIsNotNone(terminal.proc.poll())


if __name__ == '__main__':
    unittest.main(verbosity=2)

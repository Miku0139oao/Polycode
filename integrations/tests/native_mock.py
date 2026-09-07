#!/usr/bin/env python3
"""Deterministic, local-only HTTP control + OpenAI SSE fixture; never an ACP agent."""
import copy
import hashlib
import json
import re
import secrets
import threading
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PROVIDERS = ('codex', 'cursor')
MODELS = {'codex': [('mock-alpha', 'Mock Alpha'), ('mock-beta', 'Mock Beta')],
          'cursor': [('mock-cursor', 'Mock Cursor')]}
CALL_ID = 'native-fixture-read-1'
STREAM_MARKER = 'NATIVE_STREAM_RENDERED'
TOOL_MARKER = 'NATIVE_TOOL_ROUNDTRIP_OK'
WAIT_MARKER = 'NATIVE_CANCEL_STREAM_ACTIVE'
CHILD_MARKERS = {p: f'NATIVE_CHILD_REQUEST_{p.upper()}' for p in PROVIDERS}
TASK_CALL_IDS = {p: f'native-fixture-task-{p}-1' for p in PROVIDERS}
TASK_MARKERS = {p: f'NATIVE_TASK_{p.upper()}_OK' for p in PROVIDERS}
RESUME_CHILD_MARKERS = {p: f'NATIVE_RESUMED_CHILD_REQUEST_{p.upper()}' for p in PROVIDERS}
RESUME_CALL_IDS = {p: f'native-fixture-task-{p}-2' for p in PROVIDERS}
RESUME_MARKERS = {p: f'NATIVE_TASK_RESUME_{p.upper()}_OK' for p in PROVIDERS}
PROMPTS = {'stream': 'Exercise the initial stream.',
           'model': 'Exercise the second model.',
           'cursor': 'Exercise the other provider.',
           'tool': 'Read the temporary test fixture using your native file tool.',
           'mcp': 'Discover and call the local fixture MCP probe through the native tools.',
           'task_codex': 'Exercise a foreground native Task on the selected Codex model.',
           'task_cursor': 'Exercise a foreground native Task on the selected Cursor model.',
           'resume_codex': 'Resume the completed native Codex child without a model override.',
           'resume_cursor': 'Resume the completed native Cursor child without a model override.',
           'wait': 'Exercise cancellation of a running response.',
           'cancelled_login': 'Exercise the current model after cancelling sign-in.',
           'redirect': 'Exercise the model redirect boundary.',
           'recover': 'Exercise recovery after cancellation.'}


class MockBridge:
    def __init__(self, fixture_path, fixture_value):
        self.fixture_path = str(fixture_path)
        self.fixture_value = fixture_value
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.logged_in = dict.fromkeys(PROVIDERS, False)
        self.catalog_generations = dict.fromkeys(PROVIDERS, 0)
        self.attempts = {}
        self.events = []
        self.requests = []
        self.trap_requests = []
        self.errors = []
        self.refresh_redirect = False
        self.release_stream = threading.Event()
        self.stream_started = threading.Event()
        self.cancel_started = threading.Event()
        self.cancel_disconnected = threading.Event()
        self.stopping = threading.Event()
        self.tool_definition = None
        self.tool_verified = False
        self.mcp_value = None
        self.mcp_verified = False
        self.native_tasks = {p: {'nonce': 'child-response-' + secrets.token_urlsafe(32),
                                 'expected_model': None, 'arguments': None, 'issued': False,
                                 'child_provider': None, 'child_model': None,
                                 'child_calls': 0, 'verified': False, 'subagent_id': None} for p in PROVIDERS}
        self.native_resumes = copy.deepcopy(self.native_tasks)
        for state in self.native_resumes.values():
            state['nonce'] = 'resumed-child-response-' + secrets.token_urlsafe(32)
            state['history_verified'] = False
        self.server = self.trap = None
        self.threads = []

    def event(self, kind, **fields):
        with self.lock:
            self.events.append({'kind': kind, **fields})

    def snapshot(self):
        with self.lock:
            return copy.deepcopy({'events': self.events, 'requests': self.requests,
                                  'trap_requests': self.trap_requests, 'errors': self.errors,
                                  'tool_verified': self.tool_verified, 'mcp_verified': self.mcp_verified,
                                  'native_tasks': {p: {'provider': p, **{k: v for k, v in state.items()
                                                   if k not in ('nonce', 'arguments')}}
                                                   for p, state in self.native_tasks.items()},
                                  'native_resumes': {p: {'provider': p, **{k: v for k, v in state.items()
                                                     if k not in ('nonce', 'arguments')}}
                                                     for p, state in self.native_resumes.items()}})

    def catalog_revision(self, provider):
        # Synthetic account/catalog identity, not a hash of any credential.
        return hashlib.sha256(json.dumps([provider, self.catalog_generations[provider],
                                          MODELS[provider]]).encode()).hexdigest()

    def catalog(self):
        with self.lock:
            return {'providers': [
                {'id': p, 'name': 'OpenAI ChatGPT' if p == 'codex' else 'Cursor',
                 'loggedIn': self.logged_in[p],
                 'catalogRevision': self.catalog_revision(p) if self.logged_in[p] else None,
                 'models': [{'id': i, 'name': n, 'contextWindow': 131072}
                            for i, n in MODELS[p]] if self.logged_in[p] else []}
                for p in PROVIDERS]}

    def complete_login(self, attempt_id):
        # Test driver only: deliberately NOT exposed as an unauthenticated HTTP route.
        with self.lock:
            attempt = self.attempts[attempt_id]
            if attempt['state'] != 'pending':
                raise AssertionError('Cannot complete a terminal login attempt')
            attempt['state'] = 'completed'
            self.logged_in[attempt['provider']] = True
            self.catalog_generations[attempt['provider']] += 1

    def child_reply(self, child_provider, provider, model, body, resume=False):
        """Reply to a native-engine child, never create or execute an agent here."""
        with self.lock:
            state = (self.native_resumes if resume else self.native_tasks)[child_provider]
            assert provider == child_provider, 'native Task child provider mismatch'
            assert state['issued'], 'native Task child arrived before parent invocation'
            assert model == state['expected_model'], 'native Task child model mismatch'
            assert state['child_calls'] == 0, 'duplicate native Task child request'
            assert state['nonce'] not in json.dumps(body), 'child nonce leaked before child response'
            if resume:
                prior = self.native_tasks[provider]
                messages = body.get('messages', [])
                assert any(m.get('role') == 'user' and CHILD_MARKERS[provider] in content_text(m.get('content'))
                           for m in messages[:-1]), 'resumed child lost original user history'
                assert any(m.get('role') == 'assistant' and prior['nonce'] in content_text(m.get('content'))
                           for m in messages[:-1]), 'resumed child lost original assistant history'
                state['history_verified'] = True
            state['child_calls'] += 1
            state['child_provider'], state['child_model'] = provider, model
            return {'content': state['nonce']}

    def task_reply(self, task_provider, provider, model, body, resume=False):
        """Issue one observed wire call, then verify only its correlated tool result."""
        with self.lock:
            assert provider == task_provider, 'native Task parent provider mismatch'
            state = (self.native_resumes if resume else self.native_tasks)[provider]
            prior = self.native_tasks[provider]
            if resume:
                assert prior['verified'] and prior['subagent_id'], 'resume requires verified original child ID'
                assert model == prior['expected_model'], 'resume parent model changed'
            messages = body.get('messages', [])
            call_id = (RESUME_CALL_IDS if resume else TASK_CALL_IDS)[provider]
            calls = [(index, call) for index, message in enumerate(messages)
                     if message.get('role') == 'assistant' for call in (message.get('tool_calls') or [])
                     if call.get('id') == call_id]
            results = [(index, message) for index, message in enumerate(messages)
                       if message.get('role') == 'tool' and message.get('tool_call_id') == call_id]
            last_user_index = max(i for i, m in enumerate(messages) if m.get('role') == 'user')
            turn_calls = [(index, call) for index, message in enumerate(messages)
                          if index > last_user_index and message.get('role') == 'assistant'
                          for call in (message.get('tool_calls') or [])]
            turn_results = [(index, message) for index, message in enumerate(messages)
                            if index > last_user_index and message.get('role') == 'tool']
            if not state['issued']:
                assert state['nonce'] not in json.dumps(body), 'child nonce leaked before parent invocation'
                assert not calls and not results and not turn_calls and not turn_results, 'unsolicited native Task call or result'
                arguments = task_arguments(body.get('tools') or [], provider, prior['subagent_id'] if resume else None)
                state['expected_model'] = model
                state['arguments'] = arguments
                state['issued'] = True
                self.event('resume_issued' if resume else 'task_issued', provider=provider, model=model, call_id=call_id,
                           **({'resume_from': prior['subagent_id']} if resume else {}))
                return {'tool_calls': [{'index': 0, 'id': call_id, 'type': 'function',
                                       'function': {'name': 'spawn_subagent', 'arguments': json.dumps(arguments)}}]}
            assert model == state['expected_model'], 'native Task parent model changed'
            assert not state['verified'], 'duplicate native Task parent completion'
            assert len(results) == 1, 'native Task requires one correlated tool result'
            assert len(calls) == 1, 'native Task requires one correlated assistant call'
            call_index, call = calls[0]
            result_index, result = results[0]
            assert last_user_index < call_index < result_index, 'native Task call/result order mismatch'
            preceding = max(i for i, m in enumerate(messages[:result_index]) if m.get('role') == 'assistant')
            assert preceding == call_index, 'native Task result follows a different assistant call'
            assert turn_calls == calls and turn_results == results, 'uncorrelated extra native Task call or result'
            function = call.get('function') or {}
            assert call.get('type') == 'function' and function.get('name') == 'spawn_subagent', 'native Task correlated tool name mismatch'
            try:
                arguments = json.loads(function.get('arguments', ''))
            except (ValueError, TypeError):
                raise AssertionError('native Task correlated arguments invalid') from None
            assert arguments == state['arguments'], 'native Task correlated arguments changed'
            assert state['child_calls'] == 1, 'native Task result lacks one observed child request'
            assert state['nonce'] in json.dumps(result.get('content')), 'native Task result lacks child nonce'
            subagent_id = returned_subagent_id(result.get('content'))
            if resume:
                assert subagent_id != prior['subagent_id'], 'resumed child must return its new run ID'
                assert state['history_verified'], 'resume history not verified'
            state['subagent_id'] = subagent_id
            state['verified'] = True
            self.event('resume_roundtrip' if resume else 'task_roundtrip', provider=provider, model=model, call_id=call_id,
                       subagent_id=subagent_id, child_calls=state['child_calls'], verified=True)
            return {'content': (RESUME_MARKERS if resume else TASK_MARKERS)[provider]}

    def start(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass  # Never print bearer tokens, URLs, or request bodies.

            def send_response(self, code, message=None):
                if getattr(self, 'request_record', None) is not None:
                    self.request_record['status'] = code
                super().send_response(code, message)

            def json_response(self, status, data, headers=None):
                raw = json.dumps(data).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def handle_request(self):
                self.request_record = None
                raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                headers = dict(self.headers)
                auth_ok = self.headers.get('Authorization') == 'Bearer ' + owner.token
                secret_elsewhere = owner.token in self.path or owner.token.encode() in raw or any(
                    owner.token in v for k, v in headers.items() if k.lower() != 'authorization')
                path = urlsplit(self.path).path
                if self.server is owner.trap:
                    with owner.lock:
                        owner.trap_requests.append({'path': path.replace(owner.token, '[REDACTED]'),
                                                    'secret_seen': owner.token in str(headers) or secret_elsewhere})
                    self.json_response(418, {'error': 'redirect trap reached'})
                    return
                try:
                    body = json.loads(raw) if raw else {}
                except ValueError:
                    self.json_response(400, {'error': 'invalid JSON'})
                    return
                with owner.lock:
                    recorded_body = json.dumps(body).replace(owner.token, '[REDACTED]')
                    for state in [*owner.native_tasks.values(), *owner.native_resumes.values()]:
                        recorded_body = recorded_body.replace(state['nonce'], '[CHILD_RESPONSE_REDACTED]')
                    self.request_record = {'method': self.command, 'path': path.replace(owner.token, '[REDACTED]'),
                                           'authenticated': auth_ok, 'secret_elsewhere': secret_elsewhere,
                                           'body': json.loads(recorded_body)}
                    owner.requests.append(self.request_record)
                if not auth_ok or secret_elsewhere:
                    self.json_response(401, {'error': 'invalid process authentication'})
                    return
                try:
                    self.route(path, body)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception as error:
                    with owner.lock:
                        owner.errors.append(str(error).replace(owner.token, '[REDACTED]'))
                    self.json_response(500, {'error': 'mock contract assertion failed'})

            def redirect(self):
                self.json_response(307, {}, {'Location': owner.trap_url + '/credential-trap'})

            def route(self, path, body):
                method = self.command
                if (method, path) in [('GET', '/control/catalog'), ('POST', '/control/refresh')]:
                    if path.endswith('refresh') and owner.refresh_redirect:
                        owner.event('control_redirect')
                        self.redirect()
                    else:
                        self.json_response(200, owner.catalog())
                    return
                if (method, path) == ('POST', '/control/validate-model'):
                    provider = body.get('provider')
                    with owner.lock:
                        valid = (provider in PROVIDERS and owner.logged_in[provider]
                                 and body.get('model') in [m[0] for m in MODELS[provider]]
                                 and body.get('catalogRevision') == owner.catalog_revision(provider)
                                 and body.get('effort') is None)
                    owner.event('model_validation', accepted=valid)
                    self.json_response(200 if valid else 400, {} if valid else
                                       {'error': {'code': 'invalid_selection',
                                                  'message': 'Synthetic catalog or effort changed'}})
                    return
                if (method, path) == ('POST', '/control/login/start'):
                    provider = body.get('provider')
                    assert provider in PROVIDERS, 'invalid login provider'
                    with owner.lock:
                        attempt_id = f'attempt-{len(owner.attempts) + 1}-/?&'
                        owner.attempts[attempt_id] = {'provider': provider, 'state': 'pending'}
                    from urllib.parse import quote
                    url = owner.trap_url + '/mock-login?attempt=' + quote(attempt_id, safe='')
                    owner.event('login_start', provider=provider, attempt_id=attempt_id, url=url)
                    self.json_response(200, {'attemptId': attempt_id, 'url': url,
                                            'instructions': 'MOCK_LOGIN_PENDING: driver-controlled sign-in'})
                    return
                if (method, path) == ('GET', '/control/login/status'):
                    attempt_id = parse_qs(urlsplit(self.path).query).get('attemptId', [''])[0]
                    with owner.lock:
                        state = owner.attempts[attempt_id]['state']
                    owner.event('login_status', attempt_id=attempt_id, state=state)
                    self.json_response(200, {'state': state})
                    return
                if (method, path) == ('POST', '/control/login/cancel'):
                    attempt_id = body['attemptId']
                    with owner.lock:
                        attempt = owner.attempts[attempt_id]
                        if attempt['state'] == 'pending':
                            attempt['state'] = 'cancelled'
                    owner.event('login_cancel', attempt_id=attempt_id)
                    self.json_response(200, {})
                    return
                if method == 'POST' and path in [f'/{p}/v1/chat/completions' for p in PROVIDERS]:
                    self.chat(path.split('/')[1], body)
                    return
                raise AssertionError(f'Unexpected endpoint: {method} {path}')

            def chunk(self, model, delta, finish=None):
                data = {'id': 'native-mock-completion', 'object': 'chat.completion.chunk', 'created': 1,
                        'model': model, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                self.wfile.write(('data: ' + json.dumps(data) + '\n\n').encode())
                self.wfile.flush()

            def finish_sse(self, model, reason='stop'):
                self.chunk(model, {}, reason)
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()

            def chat(self, provider, body):
                assert owner.logged_in[provider], 'model invoked while signed out'
                assert body.get('stream') is True, 'native request must stream'
                model = body.get('model')
                assert model in [i for i, _ in MODELS[provider]], 'wrong wire model ID'
                messages = body.get('messages', [])
                last_user = next((m.get('content') for m in reversed(messages) if m.get('role') == 'user'), None)
                # Native adapters may encode user text in standard OpenAI text blocks.
                if isinstance(last_user, list):
                    last_user = '\n'.join(b.get('text', '') for b in last_user if b.get('type') == 'text')
                system = next((m.get('content', '') for m in messages if m.get('role') == 'system'), '')
                tools = body.get('tools') or []
                auxiliary = None
                if len(tools) == 1 and tools[0].get('function', {}).get('name') == 'session_title' and body.get('tool_choice') == {'type': 'function', 'function': {'name': 'session_title'}}:
                    auxiliary = 'title_function'
                elif not tools and isinstance(system, str) and system.startswith('You predict the next line the USER will type into their coding agent.'):
                    auxiliary = 'prediction'
                elif isinstance(last_user, str) and last_user.startswith('<system-reminder>Generate a session title for the conversation above.'):
                    auxiliary = 'title'
                elif isinstance(last_user, str) and last_user.startswith('<system-reminder>Write an ultra-short dashboard line that captures the AGENT\'S REPLY'):
                    auxiliary = 'dashboard'
                # Parent assistant tool arguments also contain the child marker. Only
                # the last user message can identify a child; helpers take precedence.
                children = [(p, resumed) for resumed, markers in ((False, CHILD_MARKERS), (True, RESUME_CHILD_MARKERS))
                            for p, marker in markers.items()
                            if not auxiliary and isinstance(last_user, str) and marker in last_user]
                assert len(children) <= 1, 'ambiguous native Task child marker'
                child_provider, resumed = children[0] if children else (None, False)
                case = auxiliary or (f'child_{child_provider}' if child_provider else next(
                    (key for key, prompt in PROMPTS.items() if isinstance(last_user, str) and prompt in last_user), None))
                assert case is not None, 'unexpected model prompt (background sampler?)'
                purpose = 'auxiliary' if auxiliary else 'subagent' if child_provider else 'interactive'
                self.request_record['purpose'] = purpose
                owner.event('auxiliary' if auxiliary else 'child_chat' if child_provider else 'chat',
                            provider=provider, model=model, case=case)
                if case == 'redirect':
                    owner.event('model_redirect')
                    self.redirect()
                    return
                # Validate Task contracts before sending SSE headers, so rejected
                # calls are genuine HTTP failures and cannot resemble success streams.
                task_delta = None
                if child_provider:
                    task_delta = owner.child_reply(child_provider, provider, model, body, resumed)
                elif case in ('task_codex', 'task_cursor'):
                    task_delta = owner.task_reply(case.removeprefix('task_'), provider, model, body)
                elif case in ('resume_codex', 'resume_cursor'):
                    task_delta = owner.task_reply(case.removeprefix('resume_'), provider, model, body, True)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.close_connection = True
                self.chunk(model, {'role': 'assistant'})
                if task_delta is not None:
                    self.chunk(model, task_delta)
                    self.finish_sse(model, 'tool_calls' if 'tool_calls' in task_delta else 'stop')
                    return
                if auxiliary:
                    if auxiliary == 'title_function':
                        self.chunk(model, {'tool_calls': [{'index': 0, 'id': 'native-title-call', 'type': 'function', 'function': {'name': 'session_title', 'arguments': json.dumps({'session_title': 'Native subscription test session with original tools'})}}]})
                        self.finish_sse(model, 'tool_calls')
                    else:
                        self.chunk(model, {'content': 'NONE' if auxiliary == 'prediction' else 'Native subscription test session with original tools'})
                        self.finish_sse(model)
                    return
                if case == 'stream':
                    self.chunk(model, {'content': STREAM_MARKER})
                    owner.stream_started.set()
                    while not owner.stopping.is_set() and not owner.release_stream.wait(.1):
                        pass
                    if not owner.stopping.is_set():
                        self.chunk(model, {'content': '\nNATIVE_STREAM_FINISHED'})
                        self.finish_sse(model)
                    return
                if case == 'wait':
                    try:
                        self.chunk(model, {'content': WAIT_MARKER})
                        owner.cancel_started.set()
                        while not owner.stopping.wait(.1):
                            self.wfile.write(b': native keepalive\n\n')
                            self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        owner.cancel_disconnected.set()
                    return
                if case == 'mcp':
                    assert owner.mcp_value, 'MCP fixture value missing'
                    results = [m for m in messages if m.get('role') == 'tool']
                    completed = next((m for m in results if m.get('tool_call_id') == 'native-mcp-call'), None)
                    if completed:
                        calls = [c for m in messages if m.get('role') == 'assistant' for c in (m.get('tool_calls') or [])]
                        assert any(c.get('id') == 'native-mcp-call' and c.get('function', {}).get('name') == 'use_tool' for c in calls), 'MCP result has no correlated native call'
                        assert owner.mcp_value in json.dumps(completed), 'native MCP result lacks fixture bytes'
                        owner.mcp_verified = True
                        owner.event('mcp_roundtrip')
                        self.chunk(model, {'content': 'NATIVE_MCP_ROUNDTRIP_OK'})
                        self.finish_sse(model)
                        return
                    assert owner.mcp_value not in json.dumps(body), 'MCP fixture leaked before native invocation'
                    searched = next((m for m in results if m.get('tool_call_id') == 'native-mcp-search'), None)
                    if searched:
                        assert 'fixture__probe' in json.dumps(searched), 'native MCP tool discovery failed'
                        name, call_id, arguments = 'use_tool', 'native-mcp-call', {'tool_name': 'fixture__probe', 'tool_input': {}}
                    else:
                        name, call_id, arguments = 'search_tool', 'native-mcp-search', {'query': 'fixture probe'}
                    assert any(t.get('function', {}).get('name') == name for t in body.get('tools', [])), 'native MCP dispatch tool absent'
                    self.chunk(model, {'tool_calls': [{'index': 0, 'id': call_id, 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]})
                    self.finish_sse(model, 'tool_calls')
                    return
                if case == 'tool':
                    results = [m for m in messages if m.get('role') == 'tool' and m.get('tool_call_id') == CALL_ID]
                    if results:
                        assert owner.tool_definition is not None, 'unsolicited tool result'
                        assert owner.fixture_value in json.dumps(results), 'fixture bytes absent from native tool result'
                        calls = [c for m in messages if m.get('role') == 'assistant' for c in (m.get('tool_calls') or [])]
                        assert any(c.get('id') == CALL_ID for c in calls), 'assistant call ID lost'
                        owner.tool_verified = True
                        owner.event('tool_roundtrip')
                        self.chunk(model, {'content': TOOL_MARKER})
                        self.finish_sse(model)
                        return
                    assert owner.fixture_value not in json.dumps(body), 'fixture leaked before tool execution'
                    definition, arguments = read_tool(body.get('tools', []), owner.fixture_path)
                    owner.tool_definition = definition
                    text = json.dumps(arguments)
                    cut = len(text) // 2
                    self.chunk(model, {'tool_calls': [{'index': 0, 'id': CALL_ID, 'type': 'function',
                                                      'function': {'name': definition['name'], 'arguments': text[:cut]}}]})
                    self.chunk(model, {'tool_calls': [{'index': 0, 'function': {'arguments': text[cut:]}}]})
                    self.finish_sse(model, 'tool_calls')
                    return
                self.chunk(model, {'content': f'NATIVE_{case.upper()}_OK'})
                self.finish_sse(model)

        class Server(ThreadingHTTPServer):
            def handle_error(self, request, client_address):
                # Async handler exceptions must fail acceptance, not merely print a traceback.
                with owner.lock:
                    owner.errors.append('HTTP handler: ' + type(sys.exception()).__name__)

        self.trap = Server(('127.0.0.1', 0), Handler)
        self.server = Server(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.trap_url = f'http://127.0.0.1:{self.trap.server_port}'
        for server in (self.trap, self.server):
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .05}, daemon=True)
            thread.start()
            self.threads.append(thread)
        return self

    def close(self):
        self.stopping.set()
        self.release_stream.set()
        for server in (self.server, self.trap):
            if server:
                server.shutdown()
                server.server_close()
        for thread in self.threads:
            thread.join(timeout=2)

    def __enter__(self):
        return self.start()

    def __exit__(self, *_):
        self.close()


def content_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')
    return ''


def returned_subagent_id(content):
    text = content_text(content)
    footers = re.findall(r'<subagent_result>\s*subagent_id: ([A-Za-z0-9_-]+)\s*subagent_type: general-purpose\s*'
                         r'To continue this subagent\'s conversation, use resume_from="\1"\.\s*</subagent_result>', text)
    assert len(footers) == 1, 'native Task result lacks unique typed resume footer'
    return footers[0]


def task_arguments(tools, provider, resume_from=None):
    """Use the observed spawn_subagent wire schema, not generic TaskToolInput."""
    definitions = [t.get('function', {}) for t in tools
                   if t.get('type') == 'function' and t.get('function', {}).get('name') == 'spawn_subagent']
    assert len(definitions) == 1, 'native spawn_subagent tool absent or ambiguous'
    arguments = {'prompt': CHILD_MARKERS[provider] + '\nReturn a brief plain-text reply; do not call tools.',
                 'description': f'Native {provider} Task probe',
                 'subagent_type': 'general-purpose', 'background': False}
    if resume_from is not None:
        arguments.update(prompt=RESUME_CHILD_MARKERS[provider] + '\nContinue your prior conversation; reply briefly without tools.',
                         description=f'Native {provider} Task resume probe', resume_from=resume_from)
    schema = definitions[0].get('parameters', {})
    assert set(schema.get('required', [])) <= arguments.keys(), 'unsupported required native Task argument'
    assert arguments.keys() <= schema.get('properties', {}).keys(), 'unsupported supplied native Task argument'
    return arguments


def read_tool(tools, fixture_path):
    """Use the advertised native Read schema; never invent/execute a local tool adapter."""
    for tool in tools:
        definition = tool.get('function', {})
        if definition.get('name', '').lower() not in ('read', 'read_file'):
            continue
        schema = definition.get('parameters', {})
        props = schema.get('properties', {})
        key = next((k for k in ('target_file', 'file_path', 'path') if k in props), None)
        if key:
            arguments = {key: fixture_path}
            for required in schema.get('required', []):
                if required == key:
                    continue
                if required in ('offset', 'start_line', 'start_line_one_indexed'):
                    arguments[required] = 1
                elif required in ('limit', 'end_line', 'end_line_one_indexed_inclusive'):
                    arguments[required] = 20
                elif required == 'should_read_entire_file':
                    arguments[required] = True
                else:
                    raise AssertionError(f'Unsupported required Read argument: {required}')
            return definition, arguments
    raise AssertionError('No native Read/read_file tool with a recognized file-path schema')

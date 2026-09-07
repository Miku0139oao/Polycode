#!/usr/bin/env python3
"""Local-only subscription script + native Responses sink. Not vendor evidence."""
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from native_mock import MockBridge

CASES = ('tool_deny', 'tool_allow_once', 'billing_deny', 'billing_allow')
DENIAL = 'explicit affirmative approval was not received'


def prompt_for(case):
    action = ('Discover and invoke billing__probe using search_tool then use_tool exactly once. '
              'Do not read files or use a shell.' if case.startswith('tool_') else
              'Invoke your native web_search exactly once with query "What is the IANA example.com reserved domain? Answer in one short sentence." '
              'and allowed_domains ["iana.org"]. Do not use a shell, MCP, or subscription-side web search.')
    return f'Native acceptance case {case}. {action} If denied, do not retry; acknowledge the tool rejection and stop. Otherwise return the tool result and stop.'


def correlated_result(body, call_id, tool_name):
    messages = body.get('messages', [])
    results = [m for m in messages if m.get('role') == 'tool' and m.get('tool_call_id') == call_id]
    if not results:
        return None
    assert len(results) == 1, 'Duplicated native tool result'
    calls = [c for m in messages if m.get('role') == 'assistant' for c in (m.get('tool_calls') or [])]
    assert sum(c.get('id') == call_id and c.get('function', {}).get('name') == tool_name for c in calls) == 1, 'Uncorrelated native tool result'
    return results[0]


def scripted_reply(body, case, nonce, native_nonce, events):
    """Generate calls, never execute tools. Success markers require native round trips."""
    prefix = case + '-'
    tool = 'use_tool' if case.startswith('tool_') else 'web_search'
    result = correlated_result(body, prefix + 'call', tool)
    if result is not None:
        text = json.dumps(result)
        if case == 'billing_deny':
            assert DENIAL in text, 'Missing explicit billing denial (auth/network error is not denial)'
        elif case == 'tool_deny':
            assert any(s in text.lower() for s in ('denied', 'rejected', 'not permitted', 'not allowed', 'declined')), 'Missing native tool rejection'
            assert nonce not in text, 'Denied probe returned its private nonce'
        else:
            assert (nonce if case.startswith('tool_') else native_nonce) in text, 'Native result lacks private response nonce'
        events.append({'case': case, 'kind': 'continuation', 'call_id': prefix + 'call', 'tool': tool,
                       'explicit_billing_denial': DENIAL in text, 'correlated': True})
        return {'content': 'NATIVE_ACCEPTANCE_' + case.upper() + '_CONTINUED'}, 'stop'
    if case.startswith('tool_'):
        assert nonce not in json.dumps(body), 'Probe nonce leaked before native execution'
        search = correlated_result(body, prefix + 'search', 'search_tool')
        if search is None:
            tool, call_id, arguments = 'search_tool', prefix + 'search', {'query': 'billing probe'}
        else:
            assert 'billing__probe' in json.dumps(search), 'MCP tool not discovered'
            tool, call_id, arguments = 'use_tool', prefix + 'call', {'tool_name': 'billing__probe', 'tool_input': {}}
    else:
        assert native_nonce not in json.dumps(body), 'Native response nonce leaked before dispatch'
        call_id, arguments = prefix + 'call', {'query': 'What is the IANA example.com reserved domain? Answer in one short sentence.', 'allowed_domains': ['iana.org']}
    assert tool in [t.get('function', {}).get('name') for t in body.get('tools', [])], 'Required native tool absent: ' + tool
    events.append({'case': case, 'kind': 'tool_requested', 'call_id': call_id, 'tool': tool})
    return {'tool_calls': [{'index': 0, 'id': call_id, 'type': 'function', 'function': {'name': tool, 'arguments': json.dumps(arguments)}}]}, 'tool_calls'


class BillingFixture:
    def __init__(self, root, nonce):
        self.root, self.nonce = root, nonce
        self.token = secrets.token_urlsafe(32)
        self.native_key = 'synthetic-native-' + secrets.token_urlsafe(32)
        self.native_nonce = 'responses-nonce-' + secrets.token_hex(24)
        self.events, self.native_requests, self.catalog_requests, self.errors = [], [], [], []
        self.approved = False
        self.upstream = MockBridge(root / 'unused', 'unused')
        self.server = None

    def start(self):
        self.upstream.start()
        self.upstream.logged_in.update(codex=True, cursor=True)
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, body, content_type='application/json'):
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def handle_request(self):
                try:
                    raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                    body = json.loads(raw) if raw else {}
                    if self.command == 'GET' and self.path == '/native/v1/models':
                        matched = self.headers.get('Authorization') == 'Bearer ' + owner.native_key
                        owner.catalog_requests.append({'method': 'GET', 'path': self.path, 'native_credential_matched': matched})
                        assert matched and not raw, 'Unexpected catalog credential/body'
                        self.reply(200, {'object': 'list', 'data': [{'id': model, 'object': 'model', 'created': 1, 'owned_by': 'fixture'}
                                                                 for model in ('native-billing-fixture', 'grok-4.6', 'grok-4.5')]})
                        return  # Non-billable model discovery, not native web-search dispatch.
                    if self.path.startswith('/native/') or self.headers.get('Authorization') == 'Bearer ' + owner.native_key:
                        # Metadata-only, request-bound attribution: compare actual received bearer
                        # with known synthetic key; never persist its value or a reversible hash.
                        bearer_ok = self.headers.get('Authorization') == 'Bearer ' + owner.native_key
                        event = {'method': self.command, 'path': self.path, 'model': body.get('model'),
                                 'credential_source': 'synthetic-native-env' if bearer_ok else 'unexpected',
                                 'selected_provider': owner.selected_provider, 'after_explicit_ui_allow': owner.approved,
                                 'store': body.get('store'), 'max_output_tokens': body.get('max_output_tokens'),
                                 'tool_types': [t.get('type') for t in body.get('tools', [])],
                                 'function_names': [t.get('name') for t in body.get('tools', []) if t.get('type') == 'function'], 'status': None}
                        owner.native_requests.append(event)
                        assert self.command == 'POST' and self.path == '/native/v1/responses' and bearer_ok, 'Wrong native dispatch credential/method/path'
                        assert owner.approved, 'Native dispatch occurred before explicit UI approval'
                        assert body.get('model') == 'native-billing-fixture', 'Catalog override did not resolve configured model'
                        assert body.get('store') is False and body.get('max_output_tokens') == 8192
                        assert len(body.get('tools', [])) == 1 and body['tools'][0]['type'] == 'web_search'
                        assert len(owner.native_requests) <= 2, 'Unexpected native request/retry'
                        event['status'] = 200
                        self.reply(200, {'id': 'resp_native_fixture', 'object': 'response', 'created_at': 1,
                                         'status': 'completed', 'model': body['model'], 'output': [
                                             {'type': 'message', 'id': 'msg_native_fixture', 'status': 'completed', 'role': 'assistant',
                                              'content': [{'type': 'output_text', 'text': owner.native_nonce, 'annotations': []}]}]})
                        return
                    if self.headers.get('Authorization') != 'Bearer ' + owner.token:
                        self.reply(401, {'error': 'process authentication required'})
                        return
                    assert owner.token.encode() not in raw and owner.native_key.encode() not in raw, 'Credential in request body'
                    if self.path.endswith('/chat/completions'):
                        provider = self.path.split('/')[1]
                        assert provider in ('codex', 'cursor') and provider == owner.selected_provider, 'Wrong selected subscription'
                        messages = body.get('messages', [])
                        last = next((m.get('content') for m in reversed(messages) if m.get('role') == 'user'), '')
                        if isinstance(last, list):
                            last = '\n'.join(b.get('text', '') for b in last if b.get('type') == 'text')
                        case = next((c for c in CASES if isinstance(last, str) and prompt_for(c) in last), None)
                        # Native suggestion/title/dashboard requests continue through the stable fixture.
                        tools = body.get('tools') or []
                        if case and len(tools) > 1:
                            delta, finish = scripted_reply(body, case, owner.nonce, owner.native_nonce, owner.events)
                            event = owner.events[-1]
                            event.update(provider=provider, model=body.get('model'),
                                         request_tool_names=[t.get('function', {}).get('name') for t in tools],
                                         last_message_role=messages[-1].get('role') if messages else None,
                                         response_contains_marker=bool(delta.get('content', '').startswith('NATIVE_ACCEPTANCE_')),
                                         response_emitted=False)
                            def chunk(value, reason=None):
                                return 'data: ' + json.dumps({'id': 'permission-billing-fixture', 'object': 'chat.completion.chunk', 'created': 1,
                                                             'model': body['model'], 'choices': [{'index': 0, 'delta': value, 'finish_reason': reason}]}) + '\n\n'
                            self.send_response(200)
                            self.send_header('Content-Type', 'text/event-stream')
                            self.send_header('Connection', 'close')
                            self.end_headers()
                            self.close_connection = True
                            for frame in (chunk({'role': 'assistant'}), chunk(delta), chunk({}, finish) + 'data: [DONE]\n\n'):
                                self.wfile.write(frame.encode())
                                self.wfile.flush()
                                time.sleep(.2)  # Exercise incremental native SSE/UI delivery, not one buffered JSON blob.
                            event['response_emitted'] = True
                            return
                    request = Request(owner.upstream.url + self.path, data=raw if self.command == 'POST' else None,
                                      headers={'Authorization': 'Bearer ' + owner.upstream.token, 'Content-Type': 'application/json'}, method=self.command)
                    try:
                        response = urlopen(request, timeout=15)
                    except HTTPError as error:
                        response = error
                    with response:
                        self.reply(response.status, response.read(), response.headers.get('Content-Type', 'application/json'))
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception as error:
                    # Deliberately no arbitrary exception content; safe failure metadata only.
                    # Assertions above and scripted_reply use only constant messages/tool names.
                    message = str(error) if isinstance(error, AssertionError) else ''
                    for value in (owner.token, owner.native_key, owner.upstream.token):
                        message = message.replace(value, '[REDACTED]')
                    owner.errors.append(type(error).__name__ + (': ' + message if message else ''))
                    self.reply(500, {'error': 'fixture contract failed'})

        self.selected_provider = 'codex'
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.native_base = self.url + '/native/v1'
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .05}, daemon=True)
        self.thread.start()
        return self

    def close(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
        self.upstream.close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *_):
        self.close()

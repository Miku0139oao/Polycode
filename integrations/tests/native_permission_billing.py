#!/usr/bin/env python3
"""Real native TUI permission/billing acceptance, with strict preflight/live separation.
Linux Python 3.11+; no Rust build. See native_billing_README.md before any live run.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace

from native_pty import Terminal, isolated_environment, native_preflight, permission_key, require_network_isolation
from native_billing_fixture import BillingFixture, CASES, prompt_for
from native_live import native_child

EXPECTED_SHA = 'e8bc41336b6e40a4340a24cb37163c5448b31ab08aa790daf5c80ee09e3bde2e'
TOOL_DENY = 'No, reject (type to add feedback)'
BILLING_DENY = 'Deny native xAI service'
BILLING_ALLOW = 'Allow this native xAI service for this session scope'
BILLING_QUESTION = 'Allow native xAI web search outside ChatGPT/Cursor subscription billing?'
OFFICIAL_BASE = 'https://api.x.ai/v1'


class Blocked(RuntimeError):
    pass


def json_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def question_index(screen, label):
    # QuestionView has its own navigation, NOT PermissionView digit-submit semantics.
    # Verify exact ordered options before using stable Terminal.choose (g/j/Enter).
    rows = re.findall(r'(?m)^[ \t┃]*([1-9])[.)]?[ \t]+(?:\([○●]\)[ \t]+)?([^\n]+)$', screen)
    # Native options have an aligned description column, separated by 2+ spaces.
    matches = [int(key) - 1 for key, text in rows if re.split(r'[ \t]{2,}', text.strip(), maxsplit=1)[0] == label]
    assert len(matches) <= 1, 'Ambiguous billing question row'
    return matches[0] if matches else None


def native_config(base, model):
    # Pin BOTH catalog bases; setting only GROK_XAI_API_BASE_URL is insufficient.
    return ('[endpoints]\nxai_api_base_url = ' + json.dumps(base) + '\n'
            '[models]\nweb_search = "native-billing-acceptance"\n'
            '[model.native-billing-acceptance]\nmodel = ' + json.dumps(model) + '\n'
            'base_url = ' + json.dumps(base) + '\napi_base_url = ' + json.dumps(base) + '\n'
            'env_key = "XAI_API_KEY"\napi_backend = "responses"\ncontext_window = 131072\n'
            'hidden = true\nmax_retries = 0\n')


def setup_probe(root):
    workspace = root / 'workspace'
    workspace.mkdir()
    nonce = 'mcp-side-effect-' + os.urandom(24).hex()
    nonce_file, receipts = root / 'probe-nonce.txt', root / 'probe-receipts.jsonl'
    nonce_file.write_text(nonce)
    (workspace / '.mcp.json').write_text(json.dumps({'mcpServers': {'billing': {
        'command': '/usr/bin/python3', 'args': [str(Path(__file__).with_name('native_billing_mcp.py').resolve()), str(nonce_file), str(receipts)]}}}))
    return workspace, nonce, receipts


def ensure_count(t, count, expected, label, seconds=1):
    # Observe the pending/denied period, rather than a single race-prone snapshot.
    for _ in range(max(1, int(seconds / .1))):
        t.alive()
        t.pump(.1)
        assert count() == expected, label


def choose_tool(t, label):
    key = permission_key(t.screen.text(), label)
    assert key is not None, 'Exact native permission label missing'
    assert key != b'1', 'Never select blanket approval'
    t.send(key)
    return key.decode()


def choose_billing(t, allow, before_submit=lambda: None):
    screen = t.screen.text()
    assert BILLING_QUESTION in ' '.join(screen.split()), 'Not the native billing question'
    deny_index, allow_index = question_index(screen, BILLING_DENY), question_index(screen, BILLING_ALLOW)
    assert (deny_index, allow_index) == (0, 1), 'Unexpected billing options/order'
    t.send(b'g')
    if allow:
        t.send(b'j')
    # Navigation alone must never be approval. Caller rechecks zero dispatch
    # immediately before submitting the exact selected option with Enter.
    before_submit()
    t.send(b'\r')
    t.pump(.5)


def preflight(binary, artifacts, report, providers=('codex', 'cursor')):
    require_network_isolation()
    with tempfile.TemporaryDirectory(prefix='fixture-', dir=artifacts) as temp:
        root = Path(temp)
        workspace, nonce, receipts = setup_probe(root)
        terminal = None
        with BillingFixture(root, nonce) as bridge:
            env = isolated_environment(root, bridge, default_features=True)
            env['XAI_API_KEY'] = bridge.native_key  # synthetic, isolated, never inherited
            env['GROK_XAI_API_BASE_URL'] = bridge.native_base
            (Path(env['GROK_HOME']) / 'config.toml').write_text(native_config(bridge.native_base, 'native-billing-fixture'))
            try:
                native_preflight(binary, env)
                command = [str(binary), '--polycode-native', '--no-external-acp', '--fullscreen', '--trust', '--cwd', str(workspace)]
                report['command'] = command
                terminal = Terminal(command, env, workspace)
                terminal.wait(lambda: 'Choose a model for this native session' in terminal.screen.text() or 'Choose a provider' in terminal.screen.text(), 'native startup decision card', 60)
                assert terminal.screen.alt_screen, 'Not fullscreen native TUI'
                report.update(native_pid=terminal.proc.pid, fullscreen=True)
                # Do not type into terminal discovery/startup: a key-backed startup has
                # its own native model card, which must be dismissed before /provider.
                terminal.escape()
                terminal.command('/provider refresh')
                terminal.wait(lambda: 'Choose a provider' in terminal.screen.text() and terminal.screen.text().count('Signed in; choose a model') == 2,
                              'completed authenticated subscription catalog refresh', 60)
                terminal.escape()
                for provider in providers:
                    report['stage'] = provider + ': select subscription'
                    bridge.selected_provider = provider
                    bridge.native_nonce = 'responses-nonce-' + os.urandom(24).hex()
                    # Fresh nonce prevents an earlier authorized tool result satisfying this provider.
                    nonce = 'mcp-side-effect-' + os.urandom(24).hex()
                    (root / 'probe-nonce.txt').write_text(nonce)
                    bridge.nonce = nonce
                    terminal.command('/provider ' + provider)
                    terminal.text('Choose a model for this native session', 60)
                    terminal.text('Mock Alpha' if provider == 'codex' else 'Mock Cursor')
                    terminal.choose(0)
                    terminal.pump(1)
                    terminal.command('/new')  # Unique transcript/call IDs for this provider.
                    terminal.pump(1)
                    for case in CASES:
                        item = {'provider': provider, 'case': case, 'preflight': 'FAIL', 'real': 'BLOCKED'}
                        report['cases'].append(item)
                        report['stage'] = provider + ': ' + case + ': permission'
                        probe_before, native_before = len(json_lines(receipts)), len(bridge.native_requests)
                        bridge.approved = False
                        before = len(bridge.events)
                        terminal.command(prompt_for(case))
                        terminal.wait(lambda: any(e.get('case') == case for e in bridge.events[before:]), 'subscription tool request ' + case, 45)
                        if case.startswith('tool_'):
                            label = TOOL_DENY if case == 'tool_deny' else 'Yes'
                            terminal.wait(lambda: 'Allow (Billing) Probe?' in terminal.screen.text() and permission_key(terminal.screen.text(), label) is not None,
                                          'native MCP permission ' + label, 45)
                            ensure_count(terminal, lambda: len(json_lines(receipts)), probe_before, 'Probe side effect while pending')
                            item['pending_dispatches'] = 0
                            item['permission_digit'] = choose_tool(terminal, label)
                        else:
                            terminal.wait(lambda: BILLING_DENY in terminal.screen.text() and BILLING_ALLOW in terminal.screen.text(), 'native billing consent', 45)
                            # Effective origin/model from actual consent, then exact response sink path/model.
                            screen = ' '.join(terminal.screen.text().split())
                            assert bridge.url in screen and 'native-billing-fixture' in screen, 'Effective billing target not configured fixture'
                            ensure_count(terminal, lambda: len(bridge.native_requests), native_before, 'Native request before billing decision')
                            item['pending_dispatches'] = 0
                            def before_submit():
                                assert len(bridge.native_requests) == native_before, 'Native dispatch during question navigation'
                                bridge.approved = case == 'billing_allow'
                            choose_billing(terminal, case == 'billing_allow', before_submit)
                        def continued():
                            return any(e.get('case') == case and e['kind'] == 'continuation' for e in bridge.events[before:])
                        # PermissionView RejectOnce currently cancels the turn. This is
                        # a distinct outcome, never evidence of a role=tool continuation.
                        terminal.wait(lambda: continued() or (case == 'tool_deny' and 'Turn cancelled by user' in terminal.screen.text()),
                                      'correlated continuation or explicit reject-triggered cancellation', 45)
                        model_continued = continued()
                        item.update(model_continued=model_continued, user_cancelled=not model_continued,
                                    probe_side_effects=len(json_lines(receipts)) - probe_before,
                                    native_dispatches=len(bridge.native_requests) - native_before,
                                    rendered_continuation=False)
                        report['stage'] = provider + ': ' + case + ': render continuation'
                        if model_continued:
                            marker = 'NATIVE_ACCEPTANCE_' + case.upper() + '_CONTINUED'
                            terminal.pump(1)
                            if not any(marker in frame for frame in terminal.frames):
                                # A question may leave the conversation viewport above the
                                # latest reply. PageDown is the native scrollback action.
                                terminal.send(b'\x1b[6~')
                                item['paged_to_reply'] = True
                            terminal.text(marker)
                            item['rendered_continuation'] = True
                        else:
                            assert case == 'tool_deny' and item['permission_digit'] == '4', 'Unexpected turn cancellation'
                        expected_probe = probe_before + (case == 'tool_allow_once')
                        expected_native = native_before + (case == 'billing_allow')
                        ensure_count(terminal, lambda: len(json_lines(receipts)), expected_probe, 'Missing/replayed MCP side effect')
                        ensure_count(terminal, lambda: len(bridge.native_requests), expected_native, 'Missing/replayed/denied native dispatch')
                        assert not bridge.errors and not bridge.upstream.errors, 'Fixture contract error'
                        if case == 'tool_allow_once':
                            assert json_lines(receipts)[-1]['nonce'] == nonce
                        item.update(preflight='PASS', model_continued=model_continued, user_cancelled=not model_continued,
                                    probe_side_effects=expected_probe - probe_before, native_dispatches=expected_native - native_before)
                report['preflight'] = 'PASS'
            finally:
                secrets = (bridge.token, bridge.native_key, bridge.upstream.token)
                def redact(text):
                    for value in secrets:
                        text = text.replace(value, '[REDACTED]')
                    return text
                if terminal:
                    terminal.close()
                    report['credential_terminal_leak'] = any(value.encode() in terminal.data for value in secrets)
                    (artifacts / 'terminal.bin').write_bytes(redact(bytes(terminal.data).decode('utf-8', 'replace')).encode())
                    (artifacts / 'screen.txt').write_text(redact(terminal.screen.text()))
                    (artifacts / 'keys.json').write_text(redact(json.dumps(terminal.steps, indent=2)))
                report['events'] = bridge.events
                report['native_requests'] = bridge.native_requests
                report['native_catalog_requests'] = bridge.catalog_requests
                report['fixture_errors'] = bridge.errors + bridge.upstream.errors
                report['probe_receipts'] = json_lines(receipts)
                if report.get('credential_terminal_leak') or report['fixture_errors']:
                    report['preflight'] = 'FAIL'


def live_gates(args):
    if not args.credentials_ready or not args.allow_subscription_usage:
        raise Blocked('Parent-confirmed working subscription credentials and explicit subscription usage permission required; OAuth is not assumed working')
    if args.case.startswith('billing_'):
        if (not args.allow_native_paid_usage or args.budget_usd is None or not math.isfinite(args.budget_usd)
                or args.budget_usd <= 0 or not args.ack_no_hard_dollar_cap):
            raise Blocked('No parent native paid-use grant/budget; 8192 max output tokens is not a hard dollar cap')
        # No observer exists in the supplied 18dce86 executable. Do not spend money
        # on a run that cannot prove the mandated dispatch/credential boundaries.
        raise Blocked('Native Rust request-bound metadata observer unavailable; see exact minimal proposal in native_billing_README.md')
    if not args.auth_directory or not args.auth_directory.is_dir():
        raise Blocked('Parent-provisioned subscription auth directory required (no credential discovery or automatic login)')


def live(binary, artifacts, args, report):
    live_gates(args)
    # Tool permission cases use genuine provider adapters with metadata-only evidence.
    # Native paid services are NOT enabled in this tool-only phase (no xAI key).
    with tempfile.TemporaryDirectory(prefix='live-', dir=artifacts) as temp:
        root = Path(temp)
        workspace, nonce, receipts = setup_probe(root)
        env = isolated_environment(root, SimpleNamespace(url='', token=''), default_features=True)
        env.pop('POLYCODE_BRIDGE_URL')
        env.pop('POLYCODE_BRIDGE_TOKEN')
        events_file = root / 'subscription-events.jsonl'
        env.update(NATIVE_BILLING_LIVE_CONSENT='yes', NATIVE_BILLING_EVENTS=str(events_file),
                   NATIVE_BILLING_NONCE_FILE=str(root / 'probe-nonce.txt'), NATIVE_BILLING_PROVIDER=args.provider,
                   NATIVE_BILLING_CASE=args.case)
        native_preflight(binary, env)
        command = [str(args.bun.resolve(strict=True)), str(Path(__file__).with_name('native_billing_live_bridge.mjs').resolve()),
                   '--binary', str(binary), '--cwd', str(workspace), '--auth-directory', str(args.auth_directory.resolve()),
                   '--', '--fullscreen', '--trust']
        terminal = None
        try:
            terminal = Terminal(command, env, workspace)
            terminal.wait(lambda: 'Choose a provider' in terminal.screen.text() or 'Choose a model for this native session' in terminal.screen.text(), 'native startup decision card', 60)
            assert terminal.screen.alt_screen, 'Not fullscreen native TUI'
            pid = native_child(terminal, binary)
            report.update(native_pid=pid, fullscreen=True)
            terminal.escape()
            terminal.command('/provider refresh')
            terminal.wait(lambda: 'Choose a provider' in terminal.screen.text() and 'Signed in; choose a model' in terminal.screen.text(),
                          'working normal-store subscription catalog', 60)
            terminal.escape()
            terminal.command('/provider ' + args.provider)
            terminal.text('Choose a model for this native session', 60)
            terminal.choose(0)
            terminal.command(prompt_for(args.case))
            label = TOOL_DENY if args.case == 'tool_deny' else 'Yes'
            terminal.wait(lambda: 'Allow (Billing) Probe?' in terminal.screen.text() and permission_key(terminal.screen.text(), label) is not None,
                          'real provider native MCP permission', 120)
            ensure_count(terminal, lambda: len(json_lines(receipts)), 0, 'Live probe side effect before approval')
            digit = choose_tool(terminal, label)
            def continued():
                return any(e.get('native_result_verified') for e in json_lines(events_file))
            terminal.wait(lambda: continued() or (args.case == 'tool_deny' and 'Turn cancelled by user' in terminal.screen.text()),
                          'live continuation or explicit reject-triggered cancellation', 120)
            model_continued = continued()
            if model_continued:
                terminal.wait(lambda: any(e.get('continuation_response_completed') for e in json_lines(events_file)), 'real subscription response completed', 120)
                if args.case == 'tool_allow_once':
                    terminal.text(nonce, 60)
            else:
                assert args.case == 'tool_deny' and digit == '4'
            dispatches = [e for e in json_lines(events_file) if e.get('kind') == 'subscription_dispatch']
            assert dispatches and all(e['sent_credential_source'] == 'selected-provider-access-token' for e in dispatches)
            assert any(e.get('status') == 200 for e in json_lines(events_file) if e.get('kind') == 'subscription_http_response')
            ensure_count(terminal, lambda: len(json_lines(receipts)), int(args.case == 'tool_allow_once'), 'Live denied/replayed probe')
            assert all(not e.get('credential_in_prompt') and not e.get('nonce_before_result') for e in json_lines(events_file))
            assert native_child(terminal, binary) == pid, 'Native child replaced during permission test'
            report['real'] = 'PASS'
            report['cases'].append({'provider': args.provider, 'case': args.case, 'real': 'PASS', 'preflight': 'NOT_RUN',
                                    'pending_dispatches': 0, 'probe_side_effects': int(args.case == 'tool_allow_once'),
                                    'permission_digit': digit, 'model_continued': model_continued, 'user_cancelled': not model_continued})
        finally:
            if terminal:
                terminal.close()
            # Never save real terminal, key frames, prompts, responses, URLs or auth state.
            report['live_events'] = json_lines(events_file)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--mode', choices=('preflight', 'live'), default='preflight')
    parser.add_argument('--expected-sha256', default=EXPECTED_SHA)
    parser.add_argument('--case', choices=CASES, default='tool_deny')
    parser.add_argument('--provider', choices=('codex', 'cursor'), default='codex', help='live selected provider')
    parser.add_argument('--preflight-provider', choices=('both', 'codex', 'cursor'), default='both')
    parser.add_argument('--auth-directory', type=Path)
    parser.add_argument('--bun', type=Path, default=Path('/usr/sbin/bun'))
    parser.add_argument('--credentials-ready', action='store_true')
    parser.add_argument('--allow-subscription-usage', action='store_true')
    parser.add_argument('--allow-native-paid-usage', action='store_true')
    parser.add_argument('--budget-usd', type=float)
    parser.add_argument('--ack-no-hard-dollar-cap', action='store_true')
    args = parser.parse_args()
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    if any(artifacts.iterdir()):
        parser.error('Artifact directory must be empty')
    report = {'preflight': 'NOT_RUN', 'real': 'BLOCKED', 'cases': [], 'mode': args.mode,
              'native_leader': True, 'default_permissions': True, 'workspace_trusted': True,
              'native_max_output_tokens': 8192, 'hard_dollar_cap': False}
    code = 1
    try:
        binary = args.binary.resolve(strict=True)
        with binary.open('rb') as stream:
            report['binary_sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
        assert report['binary_sha256'] == args.expected_sha256, 'Binary SHA mismatch; parent must explicitly approve a new build'
        if args.mode == 'preflight':
            providers = ('codex', 'cursor') if args.preflight_provider == 'both' else (args.preflight_provider,)
            preflight(binary, artifacts, report, providers)
            assert report['preflight'] == 'PASS'
        else:
            live(binary, artifacts, args, report)
        code = 0
    except Blocked as error:
        report['blocker'] = str(error)  # Only our constant safe messages.
        code = 2
    except Exception as error:
        report['failure_type'] = type(error).__name__
        if args.mode == 'preflight':
            # Assertions in this harness use static text, but shared methods may not.
            # Persist no arbitrary exception text, even for local runs.
            report['preflight'] = 'FAIL'
    finally:
        (artifacts / 'report.json').write_text(json.dumps(report, indent=2))
        print('Preflight:', report['preflight'], '| Real:', report['real'], '| Report:', artifacts / 'report.json')
    return code


if __name__ == '__main__':
    raise SystemExit(main())

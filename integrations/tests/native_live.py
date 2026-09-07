#!/usr/bin/env python3
"""Opt-in real subscription/native TUI test. Never prints URLs, tokens, or transcripts.
Browser opening emulates clicking the official URL rendered by the native TUI;
it does NOT prove the packaged WSL browser opener. Human authorization may be needed.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
from urllib.parse import urlsplit

from native_pty import Terminal, isolated_environment, native_preflight


def official_login(url, provider):
    parsed = urlsplit(url)
    allowed = {'codex': ('auth.openai.com', '/oauth/authorize'),
               'cursor': ('cursor.com', '/loginDeepControl')}
    if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443)
            or (parsed.hostname, parsed.path) != allowed[provider] or any(ord(c) < 32 for c in url)):
        raise ValueError('Not the expected official authorization URL')
    return url


def open_official_browser(url, provider):
    url = official_login(url, provider)
    # Single-quoted PowerShell literal, then encoded command; URL is never cmd.exe code.
    script = "Start-Process -FilePath '" + url.replace("'", "''") + "'"
    encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
    executable = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
    subprocess.run([executable, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                   check=True, timeout=20, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def native_child(terminal, binary):
    children = Path(f'/proc/{terminal.proc.pid}/task/{terminal.proc.pid}/children').read_text().split()
    matches = [int(pid) for pid in children if Path(f'/proc/{pid}/exe').resolve() == binary]
    if len(matches) != 1:
        raise AssertionError('Expected exactly one native TUI child')
    return matches[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--auth-directory', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--allow-subscription-usage', action='store_true')
    args = parser.parse_args()
    if not args.allow_subscription_usage:
        parser.error('Explicit --allow-subscription-usage required')
    binary = args.binary.resolve(strict=True)
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    if any(artifacts.iterdir()):
        parser.error('Artifact directory must be empty')
    report = {'passed': False, 'providers': [], 'browser_mode': 'official TUI URL clicked by test driver'}
    stage = 'startup'
    terminal = None
    with tempfile.TemporaryDirectory(prefix='polycode-live-') as temp:
        root = Path(temp)
        workspace = root / 'workspace'
        workspace.mkdir()
        nonces = {provider: 'native-live-' + os.urandom(24).hex() for provider in ('codex', 'cursor')}
        for provider, nonce in nonces.items():
            (workspace / f'native-live-{provider}.txt').write_text(nonce + '\n')
        env = isolated_environment(root, SimpleNamespace(url='', token=''))
        env.pop('POLYCODE_BRIDGE_URL')
        env.pop('POLYCODE_BRIDGE_TOKEN')
        events_file = root / 'events.jsonl'
        env.update(POLYCODE_LIVE_USAGE_CONSENT='yes', POLYCODE_LIVE_FIXTURE=str(workspace), POLYCODE_LIVE_EVENTS=str(events_file))
        def events():
            return [json.loads(line) for line in events_file.read_text().splitlines()] if events_file.exists() else []
        try:
            native_preflight(binary, env)
            with binary.open('rb') as executable:
                report['binary_sha256'] = hashlib.file_digest(executable, 'sha256').hexdigest()
            command = ['/usr/sbin/bun', str(Path(__file__).with_name('native_live_bridge.mjs')),
                       '--binary', str(binary), '--cwd', str(workspace), '--auth-directory', str(args.auth_directory.resolve()),
                       '--', '--fullscreen', '--no-auto-update', '--trust']
            terminal = Terminal(command, env, workspace)
            terminal.text('Choose a provider', timeout=90)
            assert terminal.screen.alt_screen
            pid = native_child(terminal, binary)
            report['native_pid'] = pid
            terminal.escape()
            for provider in ('codex', 'cursor'):
                stage = provider + ': authorization'
                browser_file = root / 'browser-urls.txt'
                before = len(browser_file.read_text().splitlines()) if browser_file.exists() else 0
                terminal.command('/login ' + provider)
                terminal.wait(lambda: browser_file.exists() and len(browser_file.read_text().splitlines()) > before,
                              'official authorization URL', 60)
                url = browser_file.read_text().splitlines()[-1]
                open_official_browser(url, provider)
                print('Official browser authorization opened for ' + provider + '; complete it if requested.', flush=True)
                terminal.text('Choose a model for this native session', timeout=600)
                terminal.choose(0)
                stage = provider + ': native tool'
                prompt = f'Use your native Read tool to read ./native-live-{provider}.txt now. Do not use a shell, web service, or cached answer. Reply with only its complete contents.'
                terminal.command(prompt)
                terminal.wait(lambda: any(e['provider'] == provider and e['nativeResultVerified'] for e in events()),
                              'correlated native Read result', 180)
                terminal.text(nonces[provider], timeout=180)
                assert native_child(terminal, binary) == pid, 'Native TUI process replaced'
                assert all(not e['nonceBeforeResult'] and not e['credentialInPrompt'] for e in events())
                report['providers'].append(provider)
                print('Verified real ' + provider + ' native tool result in the same TUI.', flush=True)
                terminal.pump(2)
            report.update(passed=True, same_process=True, events=events())
        except Exception as error:
            # Deliberately do not persist arbitrary error messages or terminal output.
            report.update(failure_type=type(error).__name__, stage=stage)
            if terminal:
                screen = terminal.screen.text()
                report['indicators'] = [s for s in ('Authorization failed', 'Subscription provider operation failed', 'Session creation failed', 'Allow once', 'Permission', 'Unsupported') if s in screen]
            raise SystemExit(1) from None
        finally:
            if terminal:
                terminal.close()
            (artifacts / 'report.json').write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()

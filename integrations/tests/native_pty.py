#!/usr/bin/env python3
"""Fullscreen NATIVE engine acceptance. Requires Linux, an isolated netns, and a NEW binary.
See native_README.md. Python standard library only; no real accounts or browser.
"""
import argparse
import codecs
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time
import unicodedata

from native_mock import MockBridge, PROMPTS, STREAM_MARKER, TOOL_MARKER, WAIT_MARKER


class Screen:
    """Small VT paint buffer for assertions (not just ANSI stripping/echo matching)."""
    def __init__(self, rows=55, cols=180):
        self.rows, self.cols = rows, cols
        self.cells = [[' '] * cols for _ in range(rows)]
        self.row = self.col = 0
        self.saved = (0, 0)
        self.state, self.sequence = 'text', ''
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.alt_screen = False

    def feed(self, data):
        for char in self.decoder.decode(data):
            if self.state in ('string', 'string_esc'):
                if char == '\a' or (self.state == 'string_esc' and char == '\\'):
                    self.state = 'text'
                else:
                    self.state = 'string_esc' if char == '\x1b' else 'string'
                continue
            if self.state == 'esc':
                if char == '[':
                    self.state, self.sequence = 'csi', ''
                elif char in ']P_X^':
                    self.state = 'string'
                else:
                    if char == '7':
                        self.saved = (self.row, self.col)
                    elif char == '8':
                        self.row, self.col = self.saved
                    self.state = 'text'
                continue
            if self.state == 'csi':
                if '@' <= char <= '~':
                    self.csi(char, self.sequence)
                    self.state = 'text'
                else:
                    self.sequence += char
                continue
            if char == '\x1b':
                self.state = 'esc'
            elif char == '\r':
                self.col = 0
            elif char == '\n':
                self.row = min(self.rows - 1, self.row + 1)
            elif char == '\b':
                self.col = max(0, self.col - 1)
            elif char == '\t':
                self.col = min(self.cols - 1, (self.col // 8 + 1) * 8)
            elif ord(char) >= 32 and not unicodedata.combining(char):
                if self.col >= self.cols:
                    self.col, self.row = 0, min(self.rows - 1, self.row + 1)
                self.cells[self.row][self.col] = char
                width = 2 if unicodedata.east_asian_width(char) in ('W', 'F') else 1
                if width == 2 and self.col + 1 < self.cols:
                    self.cells[self.row][self.col + 1] = ''
                self.col += width

    def csi(self, command, parameters):
        if command == 'h' and parameters == '?1049':
            self.alt_screen = True
        if parameters.startswith(('?', '>')):
            return
        try:
            values = [int(v or '0') for v in parameters.split(';')]
        except ValueError:
            return
        n = (values[0] if values else 0) or 1
        if command in ('H', 'f'):
            self.row = max(0, min(self.rows - 1, n - 1))
            self.col = max(0, min(self.cols - 1, (values[1] if len(values) > 1 else 1) - 1))
        elif command == 'A':
            self.row = max(0, self.row - n)
        elif command == 'B':
            self.row = min(self.rows - 1, self.row + n)
        elif command == 'C':
            self.col = min(self.cols - 1, self.col + n)
        elif command == 'D':
            self.col = max(0, self.col - n)
        elif command == 'G':
            self.col = min(self.cols - 1, n - 1)
        elif command == 'd':
            self.row = min(self.rows - 1, n - 1)
        elif command == 'J':
            mode = values[0]
            for row in range(self.rows):
                for col in range(self.cols):
                    if mode in (2, 3) or (mode == 0 and (row, col) >= (self.row, self.col)) or (mode == 1 and (row, col) <= (self.row, self.col)):
                        self.cells[row][col] = ' '
        elif command == 'K':
            mode = values[0]
            for col in range(self.cols):
                if mode == 2 or (mode == 0 and col >= self.col) or (mode == 1 and col <= self.col):
                    self.cells[self.row][col] = ' '
        elif command == 's':
            self.saved = (self.row, self.col)
        elif command == 'u':
            self.row, self.col = self.saved

    def text(self):
        return '\n'.join(''.join(row).rstrip() for row in self.cells)


class Terminal:
    def __init__(self, command, env, cwd):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 55, 180, 0, 0))
        self.screen = Screen()
        self.data = bytearray()
        self.query_tail = b''
        self.frames = []
        self.steps = []
        self.proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                     cwd=cwd, env=env, start_new_session=True)
        os.close(slave)
        self.identity = (self.proc.pid, Path(f'/proc/{self.proc.pid}/exe').resolve())

    def alive(self):
        assert self.proc.poll() is None, f'Native TUI exited: {self.proc.returncode}'
        assert (self.proc.pid, Path(f'/proc/{self.proc.pid}/exe').resolve()) == self.identity, 'TUI process replaced'

    def pump(self, seconds=.15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            ready, _, _ = select.select([self.master], [], [], min(.05, max(0, end - time.monotonic())))
            if not ready:
                continue
            try:
                part = os.read(self.master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            if not part:
                return
            self.data.extend(part)
            self.screen.feed(part)
            self.frames.append(self.screen.text())
            self.frames = self.frames[-80:]
            # Handle discovery even when a query is split across PTY reads.
            queries = [(b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b[0c', b'\x1b[?1;2c'),
                       (b'\x1b[6n', b'\x1b[1;1R'),
                       (b'\x1b]10;?\x1b\\', b'\x1b]10;rgb:eeee/eeee/eeee\x1b\\'),
                       (b'\x1b]11;?\x1b\\', b'\x1b]11;rgb:1111/1111/1111\x1b\\'),
                       (b'\x1b]10;?\a', b'\x1b]10;rgb:eeee/eeee/eeee\a'),
                       (b'\x1b]11;?\a', b'\x1b]11;rgb:1111/1111/1111\a')]
            merged = self.query_tail + part
            for query, response in queries:
                start = 0
                while (index := merged.find(query, start)) >= 0:
                    if index + len(query) > len(self.query_tail):
                        os.write(self.master, response)
                    start = index + len(query)
            self.query_tail = merged[-32:]

    def wait(self, predicate, description, timeout=30):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.alive()
            self.pump()
            if 'Session creation failed:' in self.screen.text():
                raise AssertionError('Native session creation failed; inspect screen and key trace')
            if predicate():
                return
        raise AssertionError('Timed out: ' + description)

    def text(self, marker, timeout=30):
        self.wait(lambda: any(marker in frame for frame in self.frames), 'render ' + marker, timeout)

    def send(self, keys):
        self.alive()
        self.frames.clear()
        before = self.screen.text()
        os.write(self.master, keys)
        self.pump(.15)
        self.steps.append({'keys_hex': keys.hex(), 'before': before, 'after': self.screen.text()})

    def command(self, text):
        self.send(text.encode() + b'\r')

    def choose(self, index):
        # Native QuestionView: g => first row, j => next (clamped), Enter => submit.
        self.send(b'g')
        for _ in range(index):
            self.send(b'j')
        self.send(b'\r')
        self.pump(.5)

    def escape(self):
        self.send(b'\x1b')
        self.pump(.4)  # Disambiguate Escape from the next CSI or prompt.

    def close(self):
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait()
        os.close(self.master)


def isolated_environment(root, bridge):
    """Allowlist instead of inheriting real OAuth/API keys, proxies, config, or browser."""
    home = root / 'home'
    home.mkdir()
    grok = home / '.grok'
    grok.mkdir()
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'GROK_HOME': str(grok),
           'XDG_CONFIG_HOME': str(home / '.config'), 'XDG_CACHE_HOME': str(home / '.cache'),
           'XDG_DATA_HOME': str(home / '.local/share'), 'XDG_STATE_HOME': str(home / '.local/state'),
           'TMPDIR': str(root), 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
           'GROK_TEST_OPEN_URL_FILE': str(root / 'browser-urls.txt'),
           'POLYCODE_BRIDGE_URL': bridge.url, 'POLYCODE_BRIDGE_TOKEN': bridge.token,
           'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1',
           'GROK_TELEMETRY_ENABLED': 'off', 'GROK_TELEMETRY_TRACE_UPLOAD': '0',
           'GROK_EXTERNAL_OTEL': '0', 'GROK_AGENT_DASHBOARD': '0'}
    return env


def require_network_isolation():
    if {name for _, name in socket.if_nameindex()} != {'lo'}:
        raise SystemExit('Refusing account/network access: use unshare --net and bring up lo; see native_README.md')


def native_preflight(binary, env):
    result = subprocess.run([str(binary), '--help'], env=env, capture_output=True, timeout=20)
    if result.returncode or b'--polycode-native' not in result.stdout or b'--no-external-acp' not in result.stdout:
        raise RuntimeError('NATIVE BINARY GATE: this binary does not advertise --polycode-native and --no-external-acp; old ACP binaries cannot pass')


def run_scenario(t, bridge, root):
    def events(kind):
        return [e for e in bridge.snapshot()['events'] if e['kind'] == kind]

    def wait_event(kind, count=1):
        t.wait(lambda: len(events(kind)) >= count, f'{kind} event #{count}')
        return events(kind)[count - 1]

    def login(provider, via_menu=False):
        count = len(events('login_start')) + 1
        if via_menu:
            t.command('/login')
            t.text('Sign in to a provider')
            t.choose(1 if provider == 'codex' else 2)
        else:
            t.command('/login ' + provider)
        attempt = wait_event('login_start', count)
        assert attempt['provider'] == provider
        t.text('MOCK_LOGIN_PENDING')
        t.wait(lambda: (root / 'browser-urls.txt').exists() and attempt['url'] in (root / 'browser-urls.txt').read_text(), 'browser suppression hook')
        return attempt['attempt_id']

    def turn(case, provider, model, marker):
        before = len(events('chat'))
        t.command(PROMPTS[case])
        t.wait(lambda: len(events('chat')) > before, case + ' HTTP request')
        request = events('chat')[before]
        assert (request['provider'], request['model'], request['case']) == (provider, model, case), request
        t.text(marker)
        t.pump(.8)

    t.text('Choose a provider', timeout=60)  # Startup is signed OUT, not bootstrapped with a dummy API key.
    assert t.screen.alt_screen, 'not the actual alternate-screen/fullscreen native TUI'
    assert not events('login_start') and not events('chat'), 'startup must not auto-login/sample'
    assert not (root / 'browser-urls.txt').exists(), 'startup opened a browser'
    assert all(not p['loggedIn'] and not p['models'] for p in bridge.catalog()['providers'])
    t.escape()
    t.command('/provider')
    t.text('Choose a provider')
    t.text('OpenAI ChatGPT')
    t.text('Cursor')
    t.escape()

    cancelled = login('cursor', via_menu=True)
    t.escape()
    wait_event('login_cancel')
    assert bridge.attempts[cancelled]['state'] == 'cancelled'
    assert not bridge.logged_in['cursor']
    t.command('/provider')
    t.text('Choose a provider')
    t.escape()  # Cancelled login must return to a responsive command prompt.

    codex = login('codex', via_menu=True)
    bridge.complete_login(codex)
    t.text('Choose a model for this native session')
    t.text('Mock Alpha')
    t.choose(0)
    turn('stream', 'codex', 'mock-alpha', STREAM_MARKER)
    assert bridge.stream_started.is_set() and not bridge.release_stream.is_set()
    # The marker is visible WHILE the HTTP response is still held open: not a buffered response.
    bridge.release_stream.set()
    t.text('NATIVE_STREAM_FINISHED')
    t.pump(1)

    t.command('/provider codex')
    t.text('Choose a model for this native session')
    t.choose(1)
    turn('model', 'codex', 'mock-beta', 'NATIVE_MODEL_OK')

    cursor = login('cursor')
    bridge.complete_login(cursor)
    t.text('Choose a model for this native session')
    t.text('Mock Cursor')
    t.choose(0)
    turn('cursor', 'cursor', 'mock-cursor', 'NATIVE_CURSOR_OK')
    turn('tool', 'cursor', 'mock-cursor', TOOL_MARKER)
    assert bridge.tool_verified, 'native file tool did not round-trip random fixture bytes'

    cancelled_active = login('codex')
    t.escape()
    wait_event('login_cancel', 2)
    assert bridge.attempts[cancelled_active]['state'] == 'cancelled'
    turn('cancelled_login', 'cursor', 'mock-cursor', 'NATIVE_CANCELLED_LOGIN_OK')

    turn('wait', 'cursor', 'mock-cursor', WAIT_MARKER)
    t.escape()
    t.wait(bridge.cancel_disconnected.is_set, 'cancel closes native HTTP stream', timeout=10)
    turn('recover', 'cursor', 'mock-cursor', 'NATIVE_RECOVER_OK')

    # Actively challenge both authenticated clients with a cross-origin 307, not merely
    # assert the absence of unsolicited traffic. The trap is a separate loopback port.
    bridge.refresh_redirect = True
    t.command('/provider refresh')
    wait_event('control_redirect')
    t.text('Bridge control request failed')
    t.escape()
    bridge.refresh_redirect = False
    t.command(PROMPTS['redirect'])
    wait_event('model_redirect')
    t.pump(2)
    t.escape()
    t.pump(2)
    t.alive()
    snapshot = bridge.snapshot()
    assert not snapshot['errors'], snapshot['errors']
    assert not snapshot['trap_requests'], 'cross-origin redirect or real browser followed a fixture URL'
    assert all(r['authenticated'] and not r['secret_elsewhere'] for r in snapshot['requests'])
    chats = [r for r in snapshot['requests'] if r['path'].endswith('/chat/completions')]
    cursor_chat = next(r['body'] for r in chats if r['path'].startswith('/cursor/') and PROMPTS['cursor'] in json.dumps(r['body']))
    history = json.dumps(cursor_chat['messages'])
    for preserved in (PROMPTS['stream'], STREAM_MARKER, PROMPTS['model'], 'NATIVE_MODEL_OK'):
        assert preserved in history, 'conversation lost while switching native provider/model: ' + preserved
    tool_sets = [{d['function']['name'] for d in r['body'].get('tools', [])} for r in chats]
    assert tool_sets[0] and all(s == tool_sets[0] for s in tool_sets), 'native tool catalog changed/lost on switch'
    assert bridge.token.encode() not in t.data, 'process token leaked to terminal'
    for request in chats:
        serialized = json.dumps(request['body'])
        auth_material = ['MOCK_LOGIN_PENDING', '/control/login', '[REDACTED]']
        auth_material.extend(e[key] for e in events('login_start') for key in ('attempt_id', 'url'))
        for forbidden in auth_material:
            assert forbidden not in serialized, 'UI-only auth material leaked into model history'
    return {'pid': t.proc.pid, 'fullscreen': True, 'same_process': True,
            'history_preserved': True, 'native_tool_names': sorted(tool_sets[0]), **snapshot}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path, help='absolute path to a newly built native Rust binary')
    parser.add_argument('--with-leader', action='store_true', help='exercise the default private native leader instead of the in-process path')
    parser.add_argument('--artifacts', type=Path, help='new directory for redacted transcript/report; defaults to /tmp/native-e2e-*')
    args = parser.parse_args()
    require_network_isolation()
    binary = args.binary.resolve(strict=True)
    artifacts = args.artifacts.resolve() if args.artifacts else Path(tempfile.mkdtemp(prefix='native-e2e-'))
    artifacts.mkdir(parents=True, exist_ok=True)
    if any(artifacts.iterdir()):
        raise SystemExit('Artifact directory must be empty')
    terminal = None
    report = {'passed': False, 'binary': str(binary), 'with_leader': args.with_leader}
    with tempfile.TemporaryDirectory(prefix='native-fixture-') as temp:
        root = Path(temp)
        workspace = root / 'workspace'
        workspace.mkdir()
        fixture = workspace / 'native-fixture.txt'
        fixture_value = 'fixture-nonce-' + os.urandom(24).hex()
        fixture.write_text(fixture_value + '\n')
        with MockBridge(fixture, fixture_value) as bridge:
            env = isolated_environment(root, bridge)
            try:
                native_preflight(binary, env)
                with binary.open('rb') as executable:
                    report['binary_sha256'] = hashlib.file_digest(executable, 'sha256').hexdigest()
                command = [str(binary), '--polycode-native', '--no-external-acp',
                           '--fullscreen', '--no-auto-update', '--trust', '--always-approve',
                           '--disable-web-search', '--no-memory', '--cwd', str(workspace)]
                if not args.with_leader:
                    command.append('--no-leader')
                terminal = Terminal(command, env, workspace)
                report.update(run_scenario(terminal, bridge, root))
                report['passed'] = True
            except Exception as error:
                report['failure'] = (type(error).__name__ + ': ' + str(error)).replace(bridge.token, '[REDACTED]')
                raise
            finally:
                if terminal:
                    terminal.close()
                    (artifacts / 'terminal.bin').write_bytes(bytes(terminal.data).replace(bridge.token.encode(), b'[REDACTED]'))
                    (artifacts / 'screen.txt').write_text(terminal.screen.text().replace(bridge.token, '[REDACTED]'))
                    (artifacts / 'keys.json').write_text(json.dumps(terminal.steps, indent=2).replace(bridge.token, '[REDACTED]'))
                report['mock'] = bridge.snapshot()
                if report['mock']['errors'] or report['mock']['trap_requests']:
                    report['passed'] = False
                terminal_leak = terminal is not None and bridge.token.encode() in terminal.data
                report['token_terminal_leak'] = terminal_leak
                if terminal_leak:
                    report['passed'] = False
                # Scan native persistence too, without publishing unrelated session files.
                leaks = [str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and bridge.token.encode() in p.read_bytes()]
                report['token_persistence_leaks'] = leaks
                if leaks:
                    report['passed'] = False
                (artifacts / 'report.json').write_text(json.dumps(report, indent=2).replace(bridge.token, '[REDACTED]'))
                print('Artifacts:', artifacts)
                if leaks:
                    raise AssertionError('Process token persisted by native TUI: ' + ', '.join(leaks))
                if report['mock']['errors'] or report['mock']['trap_requests'] or terminal_leak:
                    raise AssertionError('Mock/credential isolation failure; inspect the redacted report')
    assert report['passed'], 'Native acceptance did not finish'
    print('PASS: native fullscreen signed-out startup, login/cancel, same-process model/provider switch, streaming, native file-tool round-trip, turn cancellation, redirect credential isolation')


if __name__ == '__main__':
    main()

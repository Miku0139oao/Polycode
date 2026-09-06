#!/usr/bin/env python3
"""Run a fullscreen binary under a PTY; check rendered mock ACP output and cancel.
Usage: python pty_smoke.py BINARY [external ACP CLI arguments...]
"""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 150, 0, 0))
env = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor')
log = tempfile.NamedTemporaryFile(prefix='grok-acp-methods-', delete=False)
log.close()
env['GROK_MOCK_LOG'] = log.name
proc = subprocess.Popen([*sys.argv[1:], '--acp-arg=--log', '--acp-arg=' + log.name], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
os.close(slave)
buffer = bytearray()
def pump(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], min(.1, max(0, deadline-time.monotonic())))
        if not ready:
            if proc.poll() is not None:
                return
            continue
        try:
            data = os.read(master, 65536)
        except OSError as e:
            if e.errno == errno.EIO:
                return
            raise
        if not data:
            return
        buffer.extend(data)
        # Respond to terminal discovery without introducing keyboard input.
        if b'\x1b[c' in data or b'\x1b[0c' in data:
            os.write(master, b'\x1b[?1;2c')
        if b'\x1b[6n' in data:
            os.write(master, b'\x1b[1;1R')
        if b'\x1b]10;?' in data:
            os.write(master, b'\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
        if b'\x1b]11;?' in data:
            os.write(master, b'\x1b]11;rgb:1111/1111/1111\x1b\\')

def wait_for(marker, seconds=45):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pump(.2)
        if marker in buffer:
            return
        if proc.poll() is not None:
            break
    raise AssertionError('Missing rendered marker: ' + repr(marker))

try:
    pump(12)
    if proc.poll() is not None:
        raise AssertionError('Pager exited before prompt')
    os.write(master, b'hello\r')
    wait_for(b'MOCK_STREAM_OK')
    pump(.5)
    os.write(master, b'question\r')
    wait_for(b'MOCK_QUESTION_PICK')
    pump(.5)
    os.write(master, b'\r')
    wait_for(b'MOCK_QUESTION_EXACT_IDS')
    pump(.5)
    os.write(master, b'plan\r')
    wait_for(b'Approve this Cursor plan?')
    pump(.5)
    os.write(master, b'\r')
    wait_for(b'MOCK_PLAN_ACCEPTED')
    pump(.5)
    os.write(master, b'wait\r')
    wait_for(b'MOCK_WAITING')
    os.write(master, b'\x1b')
    pump(3)
    with open(log.name) as f:
        methods = [json.loads(line).get('method') for line in f]
    assert 'session/cancel' in methods, methods
    assert not any(m and m.startswith('x.ai/') for m in methods), methods
    print('PASS: fullscreen stream, exact question IDs, explicit plan approval, cancellation, no Grok extension RPCs')
except Exception:
    with open('/tmp/grok-pty-failure.bin', 'wb') as f:
        f.write(buffer)
    print('PTY output saved at /tmp/grok-pty-failure.bin', file=sys.stderr)
    raise
finally:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
    os.close(master)
    os.unlink(log.name)

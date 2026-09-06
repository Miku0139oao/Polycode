#!/usr/bin/env python3
"""Opt-in real-provider fullscreen smoke: consumes account/subscription usage.
Usage: python pty_live.py --allow-subscription-usage BINARY [ARGS...]
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
if len(sys.argv) < 3 or sys.argv[1] != '--allow-subscription-usage':
    raise SystemExit('Explicit --allow-subscription-usage required')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 150, 0, 0))
p = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, env=dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor'), start_new_session=True)
os.close(slave)
data = bytearray()
def pump(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([master], [], [], .1)
        if not ready:
            if p.poll() is not None:
                return
            continue
        try:
            part = os.read(master, 65536)
        except OSError as e:
            if e.errno == errno.EIO:
                return
            raise
        data.extend(part)
        if b'\x1b[c' in part or b'\x1b[0c' in part:
            os.write(master, b'\x1b[?1;2c')
        if b'\x1b[6n' in part:
            os.write(master, b'\x1b[1;1R')
        if b'\x1b]10;?' in part:
            os.write(master, b'\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
        if b'\x1b]11;?' in part:
            os.write(master, b'\x1b]11;rgb:1111/1111/1111\x1b\\')
try:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        pump(.3)
        if b'Thanks for trying Polycode' in data or p.poll() is not None:
            break
    pump(1)
    if p.poll() is not None:
        raise AssertionError('TUI exited before prompt')
    # Marker is not present verbatim in input, so echoed prompt cannot pass test.
    os.write(master, b'Reply with the three words REAL, TUI, PASS joined by underscores. Do not use tools or inspect files.\r')
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline and b'REAL_TUI_PASS' not in data:
        pump(.3)
        if p.poll() is not None:
            break
    if b'REAL_TUI_PASS' not in data:
        raise AssertionError('Real provider response was not rendered')
    print('PASS: real provider response rendered by original fullscreen TUI')
finally:
    with open('/tmp/grok-pty-live.bin', 'wb') as f:
        f.write(data)
    if p.poll() is None:
        os.write(master, b'\x03')
        pump(.3)
        os.write(master, b'\x03')
        pump(3)
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
    os.close(master)

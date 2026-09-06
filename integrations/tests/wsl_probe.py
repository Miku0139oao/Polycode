#!/usr/bin/env python3
"""Probe the Windows Codex ACP adapter from WSL without model usage.
Arguments: WINDOWS_NODE_PATH(on Linux), WINDOWS_REPO_PATH, WINDOWS_CODEX_EXE
"""
import json
import os
import subprocess
import sys
node, repo, codex = sys.argv[1:]
env = dict(os.environ)
win_node = 'C:/Program Files/nodejs/node.exe'
p = subprocess.Popen([node, repo + '/integrations/wsl-host.mjs', win_node, repo + '/integrations/codex-acp/cli.mjs', '--codex-executable', codex], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
seq = 0
def request(method, params):
    global seq
    seq += 1
    p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': seq, 'method': method, 'params': params}) + '\n')
    p.stdin.flush()
    for line in p.stdout:
        m = json.loads(line)
        if m.get('id') == seq:
            if 'error' in m:
                raise RuntimeError(m['error']['message'])
            return m['result']
    raise RuntimeError('ACP process exited')
try:
    request('initialize', {'protocolVersion': 1, 'clientCapabilities': {}, 'clientInfo': {'name': 'wsl-probe', 'version': '1.0'}})
    request('authenticate', {'methodId': 'codex_chatgpt'})
    s = request('session/new', {'cwd': os.getcwd(), 'mcpServers': []})
    assert s['sessionId'] and s['models']['availableModels']
    print('PASS: WSL → Windows ACP bridge → Codex subscription auth and session creation')
finally:
    p.stdin.close()
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()

#!/usr/bin/env python3
"""Disposable stdio MCP side-effect probe. Never captures environment or credentials."""
import json
import os
from pathlib import Path
import sys


def main():
    nonce_file, receipts = map(Path, sys.argv[1:3])
    for line in sys.stdin:
        request = json.loads(line)
        if 'id' not in request:
            continue
        method, params = request.get('method'), request.get('params') or {}
        if method == 'initialize':
            result = {'protocolVersion': params.get('protocolVersion', '2024-11-05'),
                      'capabilities': {'tools': {}}, 'serverInfo': {'name': 'native-billing-probe', 'version': '1'}}
        elif method == 'tools/list':
            result = {'tools': [{'name': 'probe', 'description': 'Append one disposable receipt and return a private nonce. Call at most once.',
                                'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
                                'annotations': {'readOnlyHint': False, 'destructiveHint': False}}]}
        elif method == 'tools/call' and params.get('name') == 'probe' and not params.get('arguments'):
            nonce = nonce_file.read_text().strip()
            fd = os.open(receipts, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, 'a') as stream:
                stream.write(json.dumps({'method': 'tools/call', 'nonce': nonce}) + '\n')
                stream.flush()
                os.fsync(stream.fileno())
            result = {'content': [{'type': 'text', 'text': nonce}], 'isError': False}
        elif method == 'ping':
            result = {}
        elif method in ('resources/list', 'prompts/list'):
            result = {method.split('/')[0]: []}
        else:
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'Unsupported probe request'}}), flush=True)
            continue
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)


if __name__ == '__main__':
    main()

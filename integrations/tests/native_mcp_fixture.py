#!/usr/bin/env python3
"""Local stdio MCP fixture. Invoked only by the native Grok MCP manager.
Raw environment evidence stays in the driver's private temporary directory.
"""
import json
import os
from pathlib import Path
import sys


def main():
    fixture, environment_log, calls_log = map(Path, sys.argv[1:4])
    def append(path, data):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, 'a') as stream:
            stream.write(json.dumps(data) + '\n')
    append(environment_log, dict(os.environ))
    for line in sys.stdin:
        request = json.loads(line)
        if 'id' not in request:
            continue
        method = request.get('method')
        params = request.get('params') or {}
        append(calls_log, {'method': method})
        if method == 'initialize':
            result = {'protocolVersion': params.get('protocolVersion', '2024-11-05'),
                      'capabilities': {'tools': {}}, 'serverInfo': {'name': 'native-fixture', 'version': '1.0'}}
        elif method == 'tools/list':
            result = {'tools': [{'name': 'probe', 'description': 'Read the native fixture probe value.',
                                 'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
                                 'annotations': {'readOnlyHint': True, 'destructiveHint': False}}]}
        elif method == 'tools/call' and params.get('name') == 'probe' and not params.get('arguments'):
            result = {'content': [{'type': 'text', 'text': fixture.read_text()}], 'isError': False}
        elif method == 'ping':
            result = {}
        elif method in ('resources/list', 'prompts/list'):
            result = {method.split('/')[0]: []}
        else:
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'Unsupported fixture request'}}), flush=True)
            continue
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Run exact cases from an EXISTING Rust test executable; never invoke Cargo.
Run inside an isolated network namespace with loopback enabled. Source edits are
not validated until the executable is deliberately rebuilt in a later batch.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

from native_pty import require_network_isolation


def run_case(binary, crate_dir, case, directory, timeout, stack_bytes):
    directory.mkdir(mode=0o700)
    home = directory / 'home'
    home.mkdir(mode=0o700)
    env = {'PATH': '/root/.cargo/bin:/usr/sbin:/usr/bin:/bin', 'HOME': str(home),
           'GROK_HOME': str(home / '.grok'), 'XDG_CONFIG_HOME': str(home / '.config'),
           'XDG_DATA_HOME': str(home / '.local/share'), 'XDG_CACHE_HOME': str(home / '.cache'),
           'XDG_STATE_HOME': str(home / '.local/state'), 'TMPDIR': str(directory),
           'CARGO_MANIFEST_DIR': str(crate_dir), 'LANG': 'C.UTF-8', 'RUST_BACKTRACE': '1',
           'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1', 'GROK_TELEMETRY_ENABLED': 'off'}
    if stack_bytes:
        env['RUST_MIN_STACK'] = str(stack_bytes)
    command = [str(binary), case, '--exact', '--nocapture', '--test-threads=1']
    started = time.monotonic()
    timed_out = False
    with (directory / 'stdout.txt').open('w') as stdout, (directory / 'stderr.txt').open('w') as stderr:
        proc = subprocess.Popen(command, cwd=crate_dir, env=env, stdin=subprocess.DEVNULL,
                                stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                code = proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                code = proc.wait()
    output = (directory / 'stdout.txt').read_text(errors='replace')
    one_pass = re.search(r'test result: ok\. 1 passed; 0 failed; 0 ignored;', output) is not None
    result = {'case': case, 'command': command, 'cwd': str(crate_dir), 'returncode': code,
              'timed_out': timed_out, 'seconds': time.monotonic() - started,
              'stack_bytes': stack_bytes, 'passed': code == 0 and not timed_out and one_pass,
              'stdout': str(directory / 'stdout.txt'), 'stderr': str(directory / 'stderr.txt')}
    (directory / 'result.json').write_text(json.dumps(result, indent=2))
    return result


def main():
    import resource
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--crate-dir', type=Path, required=True, help='Match Cargo test cwd, not workspace root')
    parser.add_argument('--case', action='append', required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--sha256', action='store_true', help='Hash once for acceptance evidence; omit for fast diagnosis')
    parser.add_argument('--stack-mib', type=int, default=32, help='Test-process resource setting; 0 retains default')
    args = parser.parse_args()
    require_network_isolation()
    if args.timeout <= 0 or args.stack_mib < 0:
        parser.error('Invalid timeout/stack setting')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    binary = args.binary.resolve(strict=True)
    crate = args.crate_dir.resolve(strict=True)
    output = args.artifacts.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    before = binary.stat()
    digest = None
    if args.sha256:
        with binary.open('rb') as executable:
            digest = hashlib.file_digest(executable, 'sha256').hexdigest()
    results = []
    for index, case in enumerate(args.case):
        # No case-derived pathname components or shell interpolation.
        results.append(run_case(binary, crate, case, output / f'case-{index:03}', args.timeout, args.stack_mib * 1024 * 1024))
    after = binary.stat()
    unchanged = (before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns)
    report = {'binary': str(binary), 'binary_sha256': digest, 'binary_size': before.st_size,
              'binary_mtime_ns': before.st_mtime_ns, 'binary_unchanged': unchanged,
              'compiled_by_runner': False, 'passed': unchanged and all(r['passed'] for r in results), 'cases': results}
    (output / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'passed': report['passed'], 'cases': len(results), 'artifacts': str(output)}))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()

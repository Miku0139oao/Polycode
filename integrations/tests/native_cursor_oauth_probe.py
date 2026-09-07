"""Explicit browser-only OAuth diagnostic; no existing auth reads/copies or raw terminal evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
from native_pty import Terminal


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--allow-browser-authorization', action='store_true', required=True)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    base = Path('/root/.local/share/polycode')
    base.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='cursor-oauth-probe-', dir=base))
    for name in ('home', 'workspace', 'config', 'data', 'cache', 'auth'):
        (root / name).mkdir(mode=0o700)
    env = {key: os.environ[key] for key in ('PATH', 'WSL_INTEROP', 'WSL_DISTRO_NAME', 'WSLENV', 'LANG') if key in os.environ}
    env.update(HOME=str(root / 'home'), XDG_CONFIG_HOME=str(root / 'config'),
               XDG_DATA_HOME=str(root / 'data'), XDG_CACHE_HOME=str(root / 'cache'),
               TERM='xterm-256color', COLORTERM='truecolor',
               DISABLE_TELEMETRY='1', DISABLE_ERROR_REPORTING='1',
               POLYCODE_AUTH_PROBE_CONSENT='yes')
    events = root / 'events.jsonl'
    with args.binary.open('rb') as executable:
        binary_hash = hashlib.file_digest(executable, 'sha256').hexdigest()
    report = {'scope': 'AUTH_ONLY_DIAGNOSTIC_NOT_RELEASE_ACCEPTANCE', 'passed': False,
              'binary_sha256': binary_hash,
              'root': str(root), 'auth_directory': str(root / 'auth'),
              'existing_credentials_read_or_copied': False, 'stage': 'startup'}
    t = None
    def observed():
        return [json.loads(line) for line in events.read_text().splitlines()] if events.exists() else []
    try:
        t = Terminal(['/usr/sbin/bun', str(Path(__file__).with_suffix('.mjs')),
                      str(args.binary), str(root / 'workspace'), str(root / 'auth'), str(events)],
                     env, root / 'workspace')
        t.text('Choose a provider', timeout=90)
        t.escape()
        t.command('/login cursor')
        report['stage'] = 'official_browser_authorization'
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            t.alive()
            t.pump(.2)
            es = observed()
            if any(e['phase'] == 'unexpected_inference_prevented' for e in es):
                report['stage'] = 'unexpected_inference_prevented'
                break
            failure = re.search(r'Authorization failed during (provider authorization|credential storage) \(([a-z_]+)(?:, HTTP ([45][0-9]{2}))?\)', t.screen.text())
            if failure:
                report.update(stage='tui_authorization_failed', failure_stage=failure[1], failure_code=failure[2], http_status=failure[3])
                break
            if any(e['phase'] == 'catalog_received' for e in es) and (root / 'auth' / 'cursor.json').is_file():
                t.text('Signed in; choose a model', timeout=15)
                report.update(stage='credential_stored_catalog_received_and_tui_confirmed', passed=True)
                break
            if any(e['phase'] in ('authorization_failed', 'catalog_failed') for e in es):
                t.pump(1)
                report['stage'] = 'provider_failure'
                break
        else:
            report['stage'] = 'authorization_not_completed_within_probe_window'
    except Exception as error:
        report.update(stage='probe_failure', failure_type=type(error).__name__)
    finally:
        if t:
            t.close()
        report['events'] = observed()
        report['inference_attempts_prevented'] = sum(e['phase'] == 'unexpected_inference_prevented' for e in report['events'])
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

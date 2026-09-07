#!/usr/bin/env python3
"""Prepare unpublished Polycode candidate assets on Linux (GitHub Actions).

Never publishes, signs in, or installs. Preserves executable bytes (no strip).
Windows packaging remains integrations/package-release.ps1.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def run(args: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True)
    return result.stdout.strip()


def gzip_file(source: Path, destination: Path) -> None:
    import gzip
    with source.open('rb') as incoming, gzip.open(destination, 'wb', compresslevel=9) as outgoing:
        shutil.copyfileobj(incoming, outgoing)


def copy_into(stage: Path, source: Path, relative: str) -> None:
    destination = stage / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--build-report', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--version', default='v0.2.0')
    parser.add_argument('--source', default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', args.version):
        raise SystemExit('Version must look like v0.2.0')
    source = Path(args.source).resolve()
    output = Path(args.output).resolve()
    if output.exists():
        raise SystemExit('Output already exists; select a fresh directory.')
    binary = Path(args.binary)
    runtime = Path(args.runtime)
    report_path = Path(args.build_report)
    report = json.loads(report_path.read_text(encoding='utf-8'))
    native_hash = run(['sha256sum', '--', str(binary)]).split()[0]
    bun_hash = run(['sha256sum', '--', str(runtime)]).split()[0]
    native_bytes = int(run(['stat', '-c', '%s', '--', str(binary)]))
    if (report.get('exit') != 0 or report.get('timeout') is not False or report.get('sha256') != native_hash
            or report.get('bytes') != native_bytes or report.get('binary') != str(binary)
            or not re.fullmatch(r'[a-f0-9]{40}', str(report.get('revision', '')))
            or report.get('profile', {}).get('test') is not False):
        raise SystemExit('Build report does not attest these exact successful native executable bytes/profile.')
    native_elf = run(['file', '-b', '--', str(binary)])
    bun_elf = run(['file', '-b', '--', str(runtime)])
    for label, elf in (('native', native_elf), ('bun', bun_elf)):
        if not re.match(r'ELF 64-bit LSB .*x86-64', elf):
            raise SystemExit(f'{label} input must be an x86_64 ELF executable.')
    native_libraries = run(['ldd', '--', str(binary)])
    bun_libraries = run(['ldd', '--', str(runtime)])
    if 'not found' in native_libraries + bun_libraries:
        raise SystemExit('Missing ELF runtime dependency.')
    help_text = run(['timeout', '30', str(binary), '--help'])
    for flag in ('--no-external-acp', '--polycode-native', '--polycode-provider'):
        if flag not in help_text:
            raise SystemExit(f'Not a native Polycode binary: missing {flag}')
    bun_version = run(['timeout', '30', str(runtime), '--version'])
    bun_revision = run(['timeout', '30', str(runtime), '--revision'])
    if bun_version != '1.3.14':
        raise SystemExit('This candidate package is qualified for Bun 1.3.14 only.')

    provider = source / 'integrations' / 'native-provider'
    with tempfile.TemporaryDirectory(prefix='polycode-package-') as work_raw:
        work = Path(work_raw)
        stage = work / 'runtime'
        payload = work / 'assets'
        payload.mkdir(parents=True)
        for relative in ('polycode.ps1', 'integrations/launch.ps1', 'integrations/RELEASE_READINESS.md', 'LICENSE', 'THIRD-PARTY-NOTICES'):
            copy_into(stage, source / relative, relative)
        bundle = stage / 'integrations' / 'native-provider' / 'launch.mjs'
        bundle.parent.mkdir(parents=True, exist_ok=True)
        run([str(runtime), 'build', str(provider / 'launch.mjs'), '--target=bun', '--outfile', str(bundle)])
        run([str(runtime), '-e', 'const entry=process.argv[1]; process.argv[1]="polycode-package-check"; await import(entry)', str(bundle)])
        for name in ('LICENSE.reference', 'PROVENANCE.md', 'package.json'):
            copy_into(stage, provider / 'cursor' / name, f'third-party/cursor/{name}')
        copy_into(stage, provider / 'BUN-LICENSE.md', 'third-party/BUN-LICENSE.md')
        copy_into(stage, provider / 'package-lock.json', 'third-party/package-lock.json')
        lock = json.loads((provider / 'package-lock.json').read_text(encoding='utf-8'))
        dependencies = []
        for name, value in lock.get('packages', {}).items():
            if not name:
                continue
            if not name.startswith('node_modules/') or re.search(r'(^|/)\.\.(/|$)', name):
                raise SystemExit('Unsafe dependency lock path.')
            module = provider / name
            package = json.loads((module / 'package.json').read_text(encoding='utf-8'))
            if package.get('version') != value.get('version'):
                raise SystemExit('Installed dependencies differ from lockfile. Run npm ci --ignore-scripts.')
            licenses = [path for path in module.iterdir() if path.is_file() and re.match(r'(?i)(licen[cs]e|copying|notice)(\.|$)', path.name)]
            if not licenses:
                raise SystemExit(f'Missing dependency license: {package["name"]}')
            relative = 'third-party/npm/' + name[len('node_modules/'):]
            for license_file in licenses:
                copy_into(stage, license_file, f'{relative}/{license_file.name}')
            copy_into(stage, module / 'package.json', f'{relative}/package.json')
            dependencies.append({'name': package['name'], 'version': package['version'], 'license': package.get('license')})
        if not dependencies:
            raise SystemExit('Dependency inventory is empty.')
        (stage / 'third-party' / 'dependencies.json').write_text(json.dumps({
            'dependencies': dependencies,
            'bun': {'version': bun_version, 'revision': bun_revision, 'licenseSource': 'https://github.com/oven-sh/bun/blob/main/LICENSE.md'},
        }, indent=2) + '\n', encoding='utf-8')
        native_copy = work / 'polycode'
        bun_copy = work / 'bun'
        shutil.copy2(binary, native_copy)
        shutil.copy2(runtime, bun_copy)
        os.chmod(native_copy, os.stat(native_copy).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        os.chmod(bun_copy, os.stat(bun_copy).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        if sha256(native_copy) != native_hash or sha256(bun_copy) != bun_hash:
            raise SystemExit('Executable changed during packaging.')
        copy_into(stage, report_path, 'provenance/build-report.json')
        script = Path(__file__).resolve()
        manifest = {
            'schemaVersion': 2,
            'classification': 'immutable-candidate',
            'version': args.version,
            'provenance': 'build-report',
            'architecture': 'x86_64',
            'minimumGlibc': '2.43',
            'platform': 'Windows PowerShell 5.1+/7 + Arch WSL Linux',
            'protocol': 'native-model-bridge',
            'binarySourceSha256': native_hash,
            'native': {
                'sha256': native_hash,
                'bytes': native_bytes,
                'elf': native_elf,
                'libraries': native_libraries,
                'revision': report['revision'],
                'profile': report['profile'],
                'buildReportSha256': sha256(report_path),
                'transformed': False,
            },
            'bun': {
                'sha256': bun_hash,
                'bytes': bun_copy.stat().st_size,
                'version': bun_version,
                'revision': bun_revision,
                'elf': bun_elf,
                'libraries': bun_libraries,
            },
            'packagingScriptSha256': sha256(script),
            'acceptance': {
                'oauthChatGPT': 'USER_REPORTED_WORKING; candidate-bound formal acceptance still required',
                'oauthCursor': 'UNPROVEN; unix-second expiresAt poll rejection fixed in JS, live TUI login not re-run',
                'liveGates': 'NOT_ACCEPTED',
                'installedIntegrated': 'NOT_ACCEPTED',
                'publicationAuthorized': False,
                'publicUrl': 'DEFERRED_UNTIL_PUBLICATION',
                'pendingSourceChanges': 'Live Cursor OAuth, paid billing observer, real Task/resume and official publication remain open',
            },
        }
        (stage / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        zip_path = payload / 'polycode-runtime.zip'
        with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(p for p in stage.rglob('*') if p.is_file()):
                archive.write(path, path.relative_to(stage).as_posix())
        copied_help = run(['timeout', '30', str(native_copy), '--help'])
        for flag in ('--no-external-acp', '--polycode-native', '--polycode-provider'):
            if flag not in copied_help:
                raise SystemExit('Packaged native binary failed validation.')
        gzip_file(native_copy, payload / 'polycode-wsl-x64.gz')
        gzip_file(bun_copy, payload / 'polycode-bun-wsl-x64.gz')
        shutil.copy2(source / 'install.ps1', payload / 'install.ps1')
        manifest['files'] = [
            {'path': path.relative_to(stage).as_posix(), 'sha256': sha256(path), 'bytes': path.stat().st_size}
            for path in sorted(p for p in stage.rglob('*') if p.is_file())
        ]
        asset_names = ['polycode-wsl-x64.gz', 'polycode-bun-wsl-x64.gz', 'polycode-runtime.zip', 'install.ps1']
        manifest['artifacts'] = [
            {'path': name, 'sha256': sha256(payload / name), 'bytes': (payload / name).stat().st_size}
            for name in asset_names
        ]
        (payload / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        sums = [f'{sha256(payload / name)}  {name}' for name in asset_names + ['manifest.json']]
        (payload / 'SHA256SUMS').write_text('\n'.join(sums) + '\n', encoding='ascii')
        shutil.copytree(payload, output)
    print(f'UNPUBLISHED CANDIDATE prepared in {output}')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        sys.stderr.write(error.stderr or str(error))
        raise SystemExit(error.returncode)

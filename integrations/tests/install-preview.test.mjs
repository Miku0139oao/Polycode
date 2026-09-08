import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const source = fileURLToPath(new URL('../../install-preview.ps1', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'polycode-preview-bootstrap-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function run(runtime, script, directory = root) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const temp = join(directory, 'temp'); mkdirSync(temp, { recursive: true });
  Object.assign(env, { TEMP: temp, TMP: temp, LOCALAPPDATA: join(directory, 'local'), APPDATA: join(directory, 'roaming'),
    USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home') });
  return spawnSync(runtime, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 30000, env, maxBuffer: 1024 * 1024 });
}
function ok(result) { assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout; }
const parse = `$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(source)},[ref]$tokens,[ref]$errors); if($errors.Count){throw ($errors.Message -join '; ')}`;

test('Preview bootstrap fixes all six public hashes and does not enable stable installation', () => {
  const text = readFileSync(source, 'utf8');
  for (const hash of [
    '06607648b697bbc783e2cc730a230cc51aacb3000287c25bdee9850b630c8476',
    '6cc3df445e8b02577d8d009d308c949845a852b710f16412dd8a2d30b90de88a',
    '2cbc8617eeb3bf0b903a01bfada3f660d0357a952a4c501b9811fe077b229396',
    'adffd26e77e3d018ff138e345568fed8551e41b017d09e7832ee807adb6cdbd5',
    '7411c0ae90f6aa34c8181ca233fbf4016335b89cf4e4f50c1b062db53da13949',
    '3b6e3ceb80907f1faf30720d47746399028e8c983a18db8e88539c1ba4d63814',
  ]) assert.ok(text.includes(hash));
  assert.match(text, /https:\/\/github\.com\/Miku0139oao\/Polycode\/releases\/download\/v0\.2\.1/);
  assert.ok(!/\bexit\b(?! code)/.test(text));
  assert.ok(!/SkipHash|SkipCheck|BaseUrl|publicCandidateEnabled/.test(text));
  const installer = readFileSync(fileURLToPath(new URL('../../install.ps1', import.meta.url)), 'utf8');
  assert.match(installer, /\$publicCandidateEnabled = \$false/);
});

for (const runtime of ['powershell.exe', 'pwsh.exe']) {
  test(runtime + ': actual verification helper rejects altered bytes and releases file handles', () => {
    const fixture = join(root, runtime + '-bytes'); writeFileSync(fixture, 'trusted');
    const hash = createHash('sha256').update('trusted').digest('hex');
    const script = `${parse}; $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-PreviewAsset'},$true); Invoke-Expression $definition.Extent.Text;
      Assert-PreviewAsset ${quote(fixture)} 7 ${quote(hash)};
      $failed=$false; try { Assert-PreviewAsset ${quote(fixture)} 8 ${quote(hash)} } catch { $failed=$true }; if(-not $failed){throw 'Wrong size accepted'};
      $failed=$false; try { Assert-PreviewAsset ${quote(fixture)} 7 ('0'*64) } catch { $failed=$true }; if(-not $failed){throw 'Wrong digest accepted'};
      [IO.File]::Delete(${quote(fixture)}); 'CHECKS_PASS'`;
    assert.match(ok(run(runtime, script)), /CHECKS_PASS/);
    assert.equal(existsSync(fixture), false);
  });

  for (const mode of ['download-error', 'missing', 'wrong-size', 'wrong-hash']) {
    test(runtime + ': irm/iex failure ' + mode + ' cannot install and cleans only its temporary download', () => {
      const directory = mkdtempSync(join(root, 'failure-')), marker = join(directory, 'keep.txt'); writeFileSync(marker, 'keep');
      const behavior = mode === 'download-error' ? "throw 'fixture download failure'" : mode === 'missing' ? 'return' :
        mode === 'wrong-size' ? "[IO.File]::WriteAllText($OutFile,'bad')" : '[IO.File]::WriteAllBytes($OutFile,(New-Object byte[] 34301))';
      const script = `$ErrorActionPreference='Continue'; $protocol=[Net.ServicePointManager]::SecurityProtocol; $userPath=[Environment]::GetEnvironmentVariable('Path','User'); $script:downloads=0;
        function Invoke-WebRequest { param($Uri,[switch]$UseBasicParsing,$OutFile,$TimeoutSec,$MaximumRedirection)
          if($Uri -cne 'https://github.com/Miku0139oao/Polycode/releases/download/v0.2.1/install.ps1'){throw 'Unexpected URL'};
          $script:downloads++; ${behavior}
        }
        $failed=$false; try { [IO.File]::ReadAllText(${quote(source)}) | Invoke-Expression } catch { $failed=$true };
        if(-not $failed -or $script:downloads -ne 1){throw 'Failure did not stop before installer'};
        if($ErrorActionPreference -ne 'Continue' -or [Net.ServicePointManager]::SecurityProtocol -ne $protocol){throw 'Caller preferences changed'};
        if([Environment]::GetEnvironmentVariable('Path','User') -cne $userPath){throw 'User PATH changed'};
        if(Test-Path (Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1')){throw 'Unexpected installation'};
        if(@(Get-ChildItem $env:TEMP -Filter 'polycode-preview-download-*').Count){throw 'Download directory leaked'};
        'CALLER_ALIVE_FAILURE_HANDLED'`;
      const output = ok(run(runtime, script, directory));
      assert.match(output, /CALLER_ALIVE_FAILURE_HANDLED/);
      assert.ok(!output.includes('Polycode Preview installed.'));
      assert.equal(readFileSync(marker, 'utf8'), 'keep');
      assert.deepEqual(readdirSync(join(directory, 'temp')), []);
    });
  }

  test(runtime + ': installer arguments preserve custom paths and require explicit PATH opt-in', () => {
    const script = `${parse}; $nodes=$ast.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$installerArguments'},$true);
      if($nodes.Count -ne 2){throw 'Unexpected argument construction'};
      $downloadRoot='C:\\download space [test]'; $version='v0.2.1'; $Root='C:\\preview space [test]';
      foreach($IncludePath in @($false,$true)) {
        Invoke-Expression $nodes[0].Extent.Text;
        if(-not $IncludePath){Invoke-Expression $nodes[1].Extent.Text};
        if(($installerArguments -contains '-NoPath') -eq $IncludePath){throw 'Implicit PATH activation'};
        if($installerArguments[$installerArguments.IndexOf('-InstallRoot')+1] -cne $Root){throw 'Path not preserved'};
        if($installerArguments -notcontains '-AllowCandidate' -or $installerArguments -contains '-GitHubCandidate'){throw 'Wrong installation scope'};
      }; 'ARGUMENTS_PASS'`;
    assert.match(ok(run(runtime, script)), /ARGUMENTS_PASS/);
  });
  test(runtime + ': explicit production root is rejected before download', () => {
    const script = `$script:downloads=0; function Invoke-WebRequest {$script:downloads++; throw 'Unexpected request'};
      $failed=$false; try { & ${quote(source)} -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode') } catch { $failed=$true };
      if(-not $failed -or $script:downloads -ne 0){throw 'Production directory was not rejected early'}; 'PRODUCTION_UNCHANGED'`;
    assert.match(ok(run(runtime, script)), /PRODUCTION_UNCHANGED/);
  });
}

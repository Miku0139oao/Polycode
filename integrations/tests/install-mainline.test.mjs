import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const source = fileURLToPath(new URL('../../install-mainline.ps1', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'polycode-mainline-bootstrap-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const windowsRuntimes = ['powershell.exe', 'pwsh.exe'].filter(runtime => {
  const probe = spawnSync(runtime, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 15000 });
  return !probe.error && probe.status === 0;
});
const nativeWindows = process.platform === 'win32';
function run(runtime, script, directory = root) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const temp = join(directory, 'temp'); mkdirSync(temp, { recursive: true });
  Object.assign(env, { TEMP: temp, TMP: temp, LOCALAPPDATA: join(directory, 'local'), APPDATA: join(directory, 'roaming'),
    USERPROFILE: join(directory, 'home'), HOME: join(directory, 'home') });
  return spawnSync(runtime, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 120000, env, maxBuffer: 1024 * 1024 });
}
function ok(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, `signal=${result.signal ?? 'none'}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}
const parse = `$tokens=$null; $errors=$null; $text=[IO.File]::ReadAllText(${quote(source)},[Text.Encoding]::UTF8); $ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors); if($errors.Count){throw ($errors.Message -join '; ')}`;
const installerHash = '06607648b697bbc783e2cc730a230cc51aacb3000287c25bdee9850b630c8476';
const bunHash = '7411c0ae90f6aa34c8181ca233fbf4016335b89cf4e4f50c1b062db53da13949';
const previewHashes = [
  installerHash,
  '6cc3df445e8b02577d8d009d308c949845a852b710f16412dd8a2d30b90de88a',
  '2cbc8617eeb3bf0b903a01bfada3f660d0357a952a4c501b9811fe077b229396',
  'adffd26e77e3d018ff138e345568fed8551e41b017d09e7832ee807adb6cdbd5',
  bunHash,
  '3b6e3ceb80907f1faf30720d47746399028e8c983a18db8e88539c1ba4d63814',
];
const stableHashes = [
  installerHash,
  '11709e24c2f2d44eca53f2f2f06425a73670b4d807606543c9d50fb8fc4e291a',
  '45219a4f2a42655f582a5f8bd288d909ae2f1d47edbf416254ef74c083543895',
  '536871a7aa419acd5116693f06b791e638ba1d50568cd14202a56c6437b18d3a',
  bunHash,
  'ee8b18ca7be25d40bbff4463d40a3486c3c443cb73c3685191fd569b38eca86b',
];

test('Channel bootstrap pins Preview and Stable hashes and does not enable official stable installation', () => {
  const text = readFileSync(source, 'utf8');
  for (const hash of [...previewHashes, ...stableHashes]) assert.ok(text.includes(hash), hash);
  assert.match(text, /\$previewAssets = \[ordered\]@\{/);
  assert.match(text, /\$stableAssets = \[ordered\]@\{/);
  assert.match(text, /https:\/\/github\.com\/Miku0139oao\/Polycode\/releases\/download\/v0\.2\.1/);
  assert.match(text, /831e7375f88be4a346481c4b18d40cab8887f1d3/);
  assert.match(text, /34380813272/);
  assert.match(text, /param\(\s*\[string\]\$InstallRoot,\s*\[string\]\$Action,\s*\[string\]\$Channel,\s*\[switch\]\$NoPath\s*\)/);
  assert.match(text, /\$IncludePath = -not \$NoPath/);
  assert.match(text, /function Assert-ChannelAsset/);
  assert.match(text, /function Read-MenuChoice/);
  assert.match(text, /function Resolve-InstallAction/);
  assert.match(text, /function Resolve-InstallChannel/);
  assert.match(text, /你要做什麼？/);
  assert.match(text, /安裝哪個頻道？/);
  assert.match(text, /@\('安裝', '更新'\)/);
  assert.match(text, /穩定版 — 目前 Windows 建議包/);
  assert.match(text, /Preview — v0\.2\.1（2026-09-08 已發布）/);
  assert.match(text, /官方穩定版尚未通過完整驗收/);
  assert.match(text, /Specify -Action Install\|Update and -Channel Stable\|Preview\./);
  assert.match(text, /這個頻道還沒安裝，改為安裝。/);
  assert.match(text, /polycode-channel-download-/);
  assert.match(text, /Polycode \{0\} \{1\}\. No login or model request was started\./);
  assert.equal((text.match(/function Assert-ChannelAsset/g) || []).length, 1);
  assert.ok(!text.includes('Assert-MainlineAsset'));
  assert.ok(!text.includes('polycode-mainline-download-'));
  assert.ok(!/\bexit\b(?! code)/.test(text));
  assert.ok(!/SkipHash|SkipCheck|BaseUrl|publicCandidateEnabled/.test(text));
  assert.equal(readFileSync(source).subarray(0, 3).toString('hex'), 'efbbbf', 'UTF-8 BOM required for Windows PowerShell 5.1 -File');
  const installer = readFileSync(fileURLToPath(new URL('../../install.ps1', import.meta.url)), 'utf8');
  assert.match(installer, /\$publicCandidateEnabled = \$false/);
});

test('Channel bootstrap keeps Preview bytes on the v0.2.1 release and Stable bytes on the CI asset commit', () => {
  const text = readFileSync(source, 'utf8');
  const previewBlock = text.slice(text.indexOf('$previewAssets'), text.indexOf('$stableAssets'));
  const stableBlock = text.slice(text.indexOf('$stableAssets'), text.indexOf('function Assert-ChannelAsset'));
  for (const hash of previewHashes) assert.ok(previewBlock.includes(hash), 'preview ' + hash);
  for (const hash of stableHashes) assert.ok(stableBlock.includes(hash), 'stable ' + hash);
  assert.ok(!previewBlock.includes('831e7375f88be4a346481c4b18d40cab8887f1d3'));
  assert.ok(!previewBlock.includes('536871a7aa419acd5116693f06b791e638ba1d50568cd14202a56c6437b18d3a'));
  assert.ok(!stableBlock.includes('adffd26e77e3d018ff138e345568fed8551e41b017d09e7832ee807adb6cdbd5'));
  assert.match(previewBlock, /\$releaseBase \+ '\/polycode-windows-x64\.gz'/);
  assert.match(stableBlock, /\$commitBase \+ '\/polycode-windows-x64\.gz'/);
  assert.ok(!previewBlock.includes('$commitBase'));
});

for (const runtime of windowsRuntimes) {
  test(runtime + ': actual verification helper rejects altered bytes and releases file handles', () => {
    const fixture = join(root, runtime + '-bytes'); writeFileSync(fixture, 'trusted');
    const hash = createHash('sha256').update('trusted').digest('hex');
    const script = `${parse}; $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-ChannelAsset'},$true); Invoke-Expression $definition.Extent.Text;
      Assert-ChannelAsset ${quote(fixture)} 7 ${quote(hash)};
      $failed=$false; try { Assert-ChannelAsset ${quote(fixture)} 8 ${quote(hash)} } catch { $failed=$true }; if(-not $failed){throw 'Wrong size accepted'};
      $failed=$false; try { Assert-ChannelAsset ${quote(fixture)} 7 ('0'*64) } catch { $failed=$true }; if(-not $failed){throw 'Wrong digest accepted'};
      [IO.File]::Delete(${quote(fixture)}); 'CHECKS_PASS'`;
    assert.match(ok(run(runtime, script)), /CHECKS_PASS/);
    assert.equal(existsSync(fixture), false);
  });

  test(runtime + ': action and channel resolvers accept Chinese and English labels', () => {
    const script = `${parse};
      foreach($name in @('Resolve-InstallAction','Resolve-InstallChannel')) {
        $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true);
        Invoke-Expression $definition.Extent.Text;
      }
      if((Resolve-InstallAction '安裝') -cne 'Install'){throw 'Install label'};
      if((Resolve-InstallAction 'update') -cne 'Update'){throw 'Update label'};
      if((Resolve-InstallChannel '穩定版') -cne 'Stable'){throw 'Stable label'};
      if((Resolve-InstallChannel '預覽') -cne 'Preview'){throw 'Preview label'};
      if($null -ne (Resolve-InstallAction 'latest')){throw 'Unknown action'};
      if($null -ne (Resolve-InstallChannel 'nightly')){throw 'Unknown channel'};
      'RESOLVERS_PASS'`;
    assert.match(ok(run(runtime, script)), /RESOLVERS_PASS/);
  });

  for (const mode of ['download-error', 'missing', 'wrong-size', 'wrong-hash']) {
    for (const channel of ['Preview', 'Stable']) {
      test(runtime + ': ' + channel + ' failure ' + mode + ' cannot install and cleans only its temporary download', { skip: nativeWindows ? false : 'requires Windows_NT host checks' }, () => {
        const directory = mkdtempSync(join(root, 'failure-')), marker = join(directory, 'keep.txt'); writeFileSync(marker, 'keep');
        const behavior = mode === 'download-error' ? "throw 'fixture download failure'" : mode === 'missing' ? 'return' :
          mode === 'wrong-size' ? "[IO.File]::WriteAllText($OutFile,'bad')" : '[IO.File]::WriteAllBytes($OutFile,(New-Object byte[] 34301))';
        const script = `$ErrorActionPreference='Continue'; $protocol=[Net.ServicePointManager]::SecurityProtocol; $userPath=[Environment]::GetEnvironmentVariable('Path','User'); $global:downloads=0;
          function global:Invoke-WebRequest { param($Uri,[switch]$UseBasicParsing,$OutFile,$TimeoutSec,$MaximumRedirection)
            if($Uri -cne 'https://github.com/Miku0139oao/Polycode/releases/download/v0.2.1/install.ps1'){throw 'Unexpected URL'};
            $global:downloads++; ${behavior}
          }
          $failed=$false; try { & ${quote(source)} -Action Install -Channel ${channel} } catch { $failed=$true };
          if(-not $failed -or $global:downloads -ne 1){throw 'Failure did not stop before installer'};
          if($ErrorActionPreference -ne 'Continue' -or [Net.ServicePointManager]::SecurityProtocol -ne $protocol){throw 'Caller preferences changed'};
          if([Environment]::GetEnvironmentVariable('Path','User') -cne $userPath){throw 'User PATH changed'};
          if(Test-Path (Join-Path $env:LOCALAPPDATA 'Polycode-Mainline')){throw 'Unexpected stable installation'};
          if(Test-Path (Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1')){throw 'Unexpected Preview installation'};
          if(@(Get-ChildItem $env:TEMP -Filter 'polycode-channel-download-*').Count){throw 'Download directory leaked'};
          'CALLER_ALIVE_FAILURE_HANDLED'`;
        const output = ok(run(runtime, script, directory));
        assert.match(output, /CALLER_ALIVE_FAILURE_HANDLED/);
        assert.ok(!output.includes('Polycode preview installed.'));
        assert.ok(!output.includes('Polycode stable installed.'));
        assert.equal(readFileSync(marker, 'utf8'), 'keep');
        assert.deepEqual(readdirSync(join(directory, 'temp')), []);
      });
    }
  }

  test(runtime + ': installer arguments preserve custom paths and add PATH unless -NoPath', () => {
    const script = `${parse}; $nodes=$ast.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$installerArguments'},$true);
      if($nodes.Count -ne 2){throw 'Unexpected argument construction'};
      $downloadRoot='C:\\download space [test]'; $version='v0.2.1'; $Root='C:\\mainline space [test]';
      foreach($IncludePath in @($false,$true)) {
        Invoke-Expression $nodes[0].Extent.Text;
        if(-not $IncludePath){Invoke-Expression $nodes[1].Extent.Text};
        if(($installerArguments -contains '-NoPath') -eq $IncludePath){throw 'Implicit PATH activation'};
        if($installerArguments[$installerArguments.IndexOf('-InstallRoot')+1] -cne $Root){throw 'Path not preserved'};
        if($installerArguments -notcontains '-AllowCandidate' -or $installerArguments -contains '-GitHubCandidate'){throw 'Wrong installation scope'};
      }; 'ARGUMENTS_PASS'`;
    assert.match(ok(run(runtime, script)), /ARGUMENTS_PASS/);
  });

  test(runtime + ': non-interactive use requires Action and Channel before any download', { skip: nativeWindows ? false : 'requires Windows_NT host checks' }, () => {
    const script = `$global:downloads=0; function global:Invoke-WebRequest {$global:downloads++; throw 'Unexpected request'};
      $failed=$false; try { & ${quote(source)} } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Menu-less invocation did not stop early'}; 'MENU_REQUIRED'`;
    assert.match(ok(run(runtime, script)), /MENU_REQUIRED/);
  });

  test(runtime + ': channel roots stay isolated and production is always rejected', { skip: nativeWindows ? false : 'requires Windows_NT host checks' }, () => {
    const script = `$global:downloads=0; function global:Invoke-WebRequest {$global:downloads++; throw 'Unexpected request'};
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Stable -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Production directory was not rejected early'};
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Preview -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Preview did not reject production'};
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Stable -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Stable did not reject Preview directory'};
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Preview -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode-Mainline') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Preview did not reject mainline directory'};
      $failed=$false; try { & ${quote(source)} -Action Update -Channel Preview -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 1){throw 'Preview root should reach download'};
      'ROOTS_UNCHANGED'`;
    assert.match(ok(run(runtime, script)), /ROOTS_UNCHANGED/);
  });
}

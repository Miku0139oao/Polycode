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
const iexRuntime = ['pwsh.exe', 'pwsh', '/tmp/pwsh/pwsh'].find(runtime => {
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
const candidateHashes = [
  installerHash,
  '1a139f51c4142d443989e20f8d86ca4b9a56dde2801227a12faafc46fd46995a',
  '689b7488093f95934fb9f03fd36b8a696bb99ef030e580eec3ba8ce79f1795d2',
  'a2f5ab22cc31076714708d8a5212e1883fe394b45ce65392c4f34eca4b3c73d0',
  bunHash,
  '45993ac5dc4008dfb779677963aeadfb1cf850b38d40ec7817d58a8e3b47ac9d',
];

test('Channel bootstrap pins Preview, Stable and Candidate hashes and does not enable official stable installation', () => {
  const text = readFileSync(source, 'utf8');
  for (const hash of [...previewHashes, ...stableHashes, ...candidateHashes]) assert.ok(text.includes(hash), hash);
  assert.match(text, /\$previewAssets = \[ordered\]@\{/);
  assert.match(text, /\$stableAssets = \[ordered\]@\{/);
  assert.match(text, /\$candidateAssets = \[ordered\]@\{/);
  assert.match(text, /https:\/\/github\.com\/Miku0139oao\/Polycode\/releases\/download\/v0\.2\.1/);
  assert.match(text, /831e7375f88be4a346481c4b18d40cab8887f1d3/);
  assert.match(text, /34380813272/);
  assert.match(text, /34492775130/);
  assert.match(text, /8e44e8b91672d97e1d46372a238263d5df1a593b/);
  assert.match(text, /polycode-windows-candidate/);
  assert.match(text, /param\(\s*\[string\]\$InstallRoot,\s*\[string\]\$Action,\s*\[string\]\$Channel,\s*\[switch\]\$NoPath,\s*\[switch\]\$Force\s*\)/);
  assert.match(text, /\$IncludePath = -not \$NoPath/);
  assert.match(text, /function Assert-ChannelAsset/);
  assert.match(text, /function Read-MenuChoice/);
  assert.match(text, /function Resolve-InstallAction/);
  assert.match(text, /function Resolve-InstallChannel/);
  assert.match(text, /function Set-PolycodePathOverwrite/);
  assert.match(text, /function Remove-PolycodePathEntry/);
  assert.match(text, /function Get-PolycodeInventory/);
  assert.match(text, /function Uninstall-PolycodeChannel/);
  assert.match(text, /function Assert-CandidateTools/);
  assert.match(text, /你要做什麼？/);
  assert.match(text, /哪一個頻道？/);
  assert.match(text, /@\('Install', 'Update', 'Overwrite', 'Switch', 'List', 'Uninstall'\)/);
  assert.match(text, /@\('Candidate', 'Preview', 'Stable'\)/);
  assert.match(text, /覆蓋 — 安裝這個頻道，並讓 PATH 上的 polycode 指向它/);
  assert.match(text, /切換 — 不重裝，只把 PATH 指到已安裝的頻道/);
  assert.match(text, /卸載 — 刪除這個頻道的目錄，並從 PATH 拿掉/);
  assert.match(text, /Candidate — ChatGPT\/Cursor 修補/);
  assert.match(text, /穩定版 — 目前 Windows 建議包/);
  assert.match(text, /Preview — v0\.2\.1（2026-09-08 已發布）/);
  assert.match(text, /官方穩定版尚未通過完整驗收/);
  assert.match(text, /Specify -Action Install\|Update\|Overwrite\|Switch\|List\|Uninstall and -Channel Stable\|Preview\|Candidate/);
  assert.match(text, /Overwrite requires PATH changes; omit -NoPath\./);
  assert.match(text, /Candidate channel requires authenticated GitHub CLI/);
  assert.match(text, /這個頻道還沒安裝，改為安裝。/);
  assert.match(text, /polycode-channel-download-/);
  assert.match(text, /Polycode \{0\} \{1\}\. No login or model request was started\./);
  assert.match(text, /Polycode \{0\} uninstalled/);
  assert.ok(!/\$publicCandidateEnabled = \$true/.test(text));
  assert.equal((text.match(/function Assert-ChannelAsset/g) || []).length, 1);
  assert.ok(!text.includes('Assert-MainlineAsset'));
  assert.ok(!text.includes('polycode-mainline-download-'));
  assert.ok(!/\bexit\b(?! code)/.test(text));
  assert.ok(!/SkipHash|SkipCheck|BaseUrl|publicCandidateEnabled/.test(text));
  const raw = readFileSync(source);
  assert.notEqual(raw.subarray(0, 3).toString('hex'), 'efbbbf', 'UTF-8 BOM makes irm | iex treat the first token as \\uFEFFparam');
  assert.match(raw.subarray(0, 16).toString('utf8'), /^param\s*\(/);
  const installer = readFileSync(fileURLToPath(new URL('../../install.ps1', import.meta.url)), 'utf8');
  assert.match(installer, /\$publicCandidateEnabled = \$false/);
});

test('Invoke-Expression of the bootstrap binds param instead of treating it as a command', { skip: iexRuntime ? false : 'requires pwsh' }, () => {
  const script = `$text = [IO.File]::ReadAllText(${quote(source)}, [Text.Encoding]::UTF8)
    if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { throw 'ReadAllText still starts with BOM' }
    $bomFailed = $false
    try { Invoke-Expression ([string][char]0xFEFF + 'param()') } catch {
      if ($_.Exception.Message -match [char]0xFEFF + 'param') { $bomFailed = $true }
    }
    if (-not $bomFailed) { throw 'BOM param fixture did not reproduce irm|iex failure' }
    $failed = $false; $message = ''
    try { Invoke-Expression $text } catch { $failed = $true; $message = $_.Exception.Message }
    if (-not $failed) { throw 'Expected bootstrap to stop after param binding' }
    if ($message -match ("term '" + [char]0xFEFF + "param'") -or $message -match "term 'param'") {
      throw ('iex still rejected param: ' + $message)
    }
    if ($message -notmatch 'Windows x64|Specify -Action') { throw ('Unexpected iex error: ' + $message) }
    $sb = [scriptblock]::Create($text)
    $names = @($sb.Ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    foreach ($need in @('InstallRoot', 'Action', 'Channel', 'NoPath', 'Force')) {
      if ($names -notcontains $need) { throw ('scriptblock lost parameter ' + $need) }
    }
    'IEX_PARAM_PASS'`;
  assert.match(ok(run(iexRuntime, script)), /IEX_PARAM_PASS/);
});

test('Channel bootstrap keeps Preview, Stable and Candidate bytes on their own pins', () => {
  const text = readFileSync(source, 'utf8');
  const previewBlock = text.slice(text.indexOf('$previewAssets'), text.indexOf('$stableAssets'));
  const stableBlock = text.slice(text.indexOf('$stableAssets'), text.indexOf('$candidateAssets'));
  const candidateBlock = text.slice(text.indexOf('$candidateAssets'), text.indexOf('function Assert-ChannelAsset'));
  for (const hash of previewHashes) assert.ok(previewBlock.includes(hash), 'preview ' + hash);
  for (const hash of stableHashes) assert.ok(stableBlock.includes(hash), 'stable ' + hash);
  for (const hash of candidateHashes) assert.ok(candidateBlock.includes(hash), 'candidate ' + hash);
  assert.ok(!previewBlock.includes('831e7375f88be4a346481c4b18d40cab8887f1d3'));
  assert.ok(!previewBlock.includes('536871a7aa419acd5116693f06b791e638ba1d50568cd14202a56c6437b18d3a'));
  assert.ok(!previewBlock.includes('a2f5ab22cc31076714708d8a5212e1883fe394b45ce65392c4f34eca4b3c73d0'));
  assert.ok(!stableBlock.includes('adffd26e77e3d018ff138e345568fed8551e41b017d09e7832ee807adb6cdbd5'));
  assert.ok(!stableBlock.includes('a2f5ab22cc31076714708d8a5212e1883fe394b45ce65392c4f34eca4b3c73d0'));
  assert.ok(!candidateBlock.includes('adffd26e77e3d018ff138e345568fed8551e41b017d09e7832ee807adb6cdbd5'));
  assert.ok(!candidateBlock.includes('536871a7aa419acd5116693f06b791e638ba1d50568cd14202a56c6437b18d3a'));
  assert.match(previewBlock, /\$releaseBase \+ '\/polycode-windows-x64\.gz'/);
  assert.match(stableBlock, /\$commitBase \+ '\/polycode-windows-x64\.gz'/);
  assert.ok(!previewBlock.includes('$commitBase'));
  assert.ok(!candidateBlock.includes('uri ='));
  assert.match(text, /gh run download \$candidateRunId -n \$candidateArtifact/);
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
      if((Resolve-InstallAction '覆蓋') -cne 'Overwrite'){throw 'Overwrite label'};
      if((Resolve-InstallAction 'overwrite') -cne 'Overwrite'){throw 'Overwrite english'};
      if((Resolve-InstallAction '切換') -cne 'Switch'){throw 'Switch label'};
      if((Resolve-InstallAction 'list') -cne 'List'){throw 'List label'};
      if((Resolve-InstallAction '卸載') -cne 'Uninstall'){throw 'Uninstall label'};
      if((Resolve-InstallChannel '穩定版') -cne 'Stable'){throw 'Stable label'};
      if((Resolve-InstallChannel '預覽') -cne 'Preview'){throw 'Preview label'};
      if((Resolve-InstallChannel '修補') -cne 'Candidate'){throw 'Candidate label'};
      if((Resolve-InstallChannel 'candidate') -cne 'Candidate'){throw 'Candidate english'};
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

  test(runtime + ': overwrite PATH helper prefers the new bin and drops other polycode launchers', { skip: nativeWindows ? false : 'requires Windows_NT host checks' }, () => {
    const directory = mkdtempSync(join(root, 'path-'));
    const script = `${parse};
      $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Set-PolycodePathOverwrite'},$true);
      Invoke-Expression $definition.Extent.Text;
      $saved=[Environment]::GetEnvironmentVariable('Path','User');
      $processSaved=$env:Path;
      try {
        $preview=Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1\\bin';
        $next=Join-Path $env:LOCALAPPDATA 'Polycode-Mainline\\bin';
        $other=Join-Path $env:LOCALAPPDATA 'tools';
        New-Item -ItemType Directory -Path $preview,$next,$other | Out-Null;
        Set-Content -LiteralPath (Join-Path $preview 'polycode.cmd') -Value '@echo preview' -Encoding ASCII;
        Set-Content -LiteralPath (Join-Path $next 'polycode.cmd') -Value '@echo mainline' -Encoding ASCII;
        [Environment]::SetEnvironmentVariable('Path', ($preview + ';' + $other), 'User');
        $env:Path = $preview + ';C:\\Windows\\System32';
        Set-PolycodePathOverwrite $next;
        $user=[Environment]::GetEnvironmentVariable('Path','User');
        if($user -notlike ($next + ';*')){throw 'New bin is not first'};
        if($user -like ('*' + $preview + '*')){throw 'Preview launcher stayed on PATH'};
        if($user -notlike ('*' + $other + '*')){throw 'Unrelated PATH entry removed'};
        if(-not (Test-Path -LiteralPath (Join-Path $preview 'polycode.cmd'))){throw 'Preview files were deleted'};
        'PATH_OVERWRITE_PASS'
      } finally {
        [Environment]::SetEnvironmentVariable('Path', $saved, 'User');
        $env:Path=$processSaved;
      }`;
    assert.match(ok(run(runtime, script, directory)), /PATH_OVERWRITE_PASS/);
  });

  test(runtime + ': inventory helper lists managed channels and reads channel-state', () => {
    const directory = mkdtempSync(join(root, 'inventory-'));
    const script = `${parse};
      foreach($name in @('Get-DefaultChannelRoot','Read-ChannelVersion','Get-PolycodeInventory','Save-ChannelState')) {
        $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true);
        Invoke-Expression $definition.Extent.Text;
      }
      $preview=Get-DefaultChannelRoot 'Preview'
      New-Item -ItemType Directory -Path $preview | Out-Null
      Save-ChannelState $preview 'Preview'
      $rows=@(Get-PolycodeInventory)
      $previewRow=$rows | Where-Object { $_.Channel -eq 'Preview' } | Select-Object -First 1
      $stableRow=$rows | Where-Object { $_.Channel -eq 'Stable' } | Select-Object -First 1
      $candidateRow=$rows | Where-Object { $_.Channel -eq 'Candidate' } | Select-Object -First 1
      if(-not $previewRow.Installed -or $previewRow.Version -notlike '*39b25f39*'){throw 'Preview state not listed'}
      if($stableRow.Installed){throw 'Stable should be absent'}
      if($candidateRow.Installed){throw 'Candidate should be absent'}
      'INVENTORY_PASS'`;
    assert.match(ok(run(runtime, script, directory)), /INVENTORY_PASS/);
  });

  test(runtime + ': uninstall helper deletes the channel root and drops only that PATH entry', { skip: nativeWindows ? false : 'requires Windows_NT host checks' }, () => {
    const directory = mkdtempSync(join(root, 'uninstall-'));
    const script = `${parse};
      foreach($name in @('Test-SamePath','Remove-PolycodePathEntry','Uninstall-PolycodeChannel')) {
        $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true);
        Invoke-Expression $definition.Extent.Text;
      }
      $saved=[Environment]::GetEnvironmentVariable('Path','User');
      $processSaved=$env:Path;
      try {
        $preview=Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1'
        $candidate=Join-Path $env:LOCALAPPDATA 'Polycode-Candidate'
        New-Item -ItemType Directory -Path (Join-Path $preview 'bin'),(Join-Path $candidate 'bin') | Out-Null
        Set-Content -LiteralPath (Join-Path $preview 'bin\\polycode.cmd') -Value '@echo preview' -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $candidate 'bin\\polycode.cmd') -Value '@echo candidate' -Encoding ASCII
        [Environment]::SetEnvironmentVariable('Path', ((Join-Path $preview 'bin') + ';' + (Join-Path $candidate 'bin')), 'User')
        Uninstall-PolycodeChannel $preview 'Preview'
        if(Test-Path -LiteralPath $preview){throw 'Preview root remained'}
        if(-not (Test-Path -LiteralPath (Join-Path $candidate 'bin\\polycode.cmd'))){throw 'Candidate files were deleted'}
        $user=[Environment]::GetEnvironmentVariable('Path','User')
        if($user -like ('*' + (Join-Path $preview 'bin') + '*')){throw 'Preview PATH entry remained'}
        if($user -notlike ('*' + (Join-Path $candidate 'bin') + '*')){throw 'Candidate PATH entry was removed'}
        $failed=$false; try { Uninstall-PolycodeChannel (Join-Path $env:LOCALAPPDATA 'Polycode') 'Production' } catch { $failed=$true }
        if(-not $failed){throw 'Production uninstall was allowed'}
        'UNINSTALL_PASS'
      } finally {
        [Environment]::SetEnvironmentVariable('Path', $saved, 'User');
        $env:Path=$processSaved;
      }`;
    assert.match(ok(run(runtime, script, directory)), /UNINSTALL_PASS/);
  });

  test(runtime + ': overwrite rejects -NoPath before any download', { skip: nativeWindows ? false : 'requires Windows_NT host checks' }, () => {
    const script = `$global:downloads=0; function global:Invoke-WebRequest {$global:downloads++; throw 'Unexpected request'};
      $failed=$false; try { & ${quote(source)} -Action Overwrite -Channel Stable -NoPath } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Overwrite -NoPath did not stop early'}; 'OVERWRITE_NOPATH'`;
    assert.match(ok(run(runtime, script)), /OVERWRITE_NOPATH/);
  });

  test(runtime + ': non-interactive use requires Action and Channel before any download', { skip: nativeWindows ? false : 'requires Windows_NT host checks' }, () => {
    const script = `$global:downloads=0; function global:Invoke-WebRequest {$global:downloads++; throw 'Unexpected request'};
      $failed=$false; try { & ${quote(source)} } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Menu-less invocation did not stop early'}; 'MENU_REQUIRED'`;
    assert.match(ok(run(runtime, script)), /MENU_REQUIRED/);
  });

  test(runtime + ': channel roots stay isolated and production is always rejected', { skip: nativeWindows ? false : 'requires Windows_NT host checks' }, () => {
    const script = `$global:downloads=0; function global:Invoke-WebRequest {$global:downloads++; throw 'Unexpected request'};
      function global:gh { $global:downloads++; throw 'Unexpected gh' }
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Stable -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Production directory was not rejected early'};
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Preview -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Preview did not reject production'};
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Stable -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Stable did not reject Preview directory'};
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Preview -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode-Mainline') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Preview did not reject mainline directory'};
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Candidate -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Candidate did not reject Preview directory'};
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Preview -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode-Candidate') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 0){throw 'Preview did not reject candidate directory'};
      $failed=$false; try { & ${quote(source)} -Action Update -Channel Preview -InstallRoot (Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1') } catch { $failed=$true };
      if(-not $failed -or $global:downloads -ne 1){throw 'Preview root should reach download'};
      'ROOTS_UNCHANGED'`;
    assert.match(ok(run(runtime, script)), /ROOTS_UNCHANGED/);
  });

  test(runtime + ': list switch and uninstall do not download', { skip: nativeWindows ? false : 'requires Windows_NT host checks' }, () => {
    const directory = mkdtempSync(join(root, 'manage-'));
    const script = `$global:downloads=0; function global:Invoke-WebRequest {$global:downloads++; throw 'Unexpected request'};
      function global:gh { $global:downloads++; throw 'Unexpected gh' }
      $preview=Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1'
      New-Item -ItemType Directory -Path (Join-Path $preview 'bin') | Out-Null
      Set-Content -LiteralPath (Join-Path $preview 'bin\\polycode.cmd') -Value '@echo preview' -Encoding ASCII
      & ${quote(source)} -Action List
      $failed=$false; try { & ${quote(source)} -Action Switch -Channel Candidate } catch { $failed=$true }
      if(-not $failed){throw 'Switch allowed a missing channel'}
      & ${quote(source)} -Action Switch -Channel Preview
      & ${quote(source)} -Action Uninstall -Channel Preview -Force
      if($global:downloads -ne 0){throw 'Version management started a download'}
      if(Test-Path -LiteralPath $preview){throw 'Uninstall left the Preview directory'}
      'MANAGE_NO_DOWNLOAD'`;
    assert.match(ok(run(runtime, script, directory)), /MANAGE_NO_DOWNLOAD/);
  });

  test(runtime + ': candidate install fails closed when gh cannot download', { skip: nativeWindows ? false : 'requires Windows_NT host checks' }, () => {
    const script = `$global:downloads=0; function global:Invoke-WebRequest {$global:downloads++; throw 'Unexpected request'};
      function global:gh { $global:downloads++; throw 'fixture gh failure' }
      $failed=$false; try { & ${quote(source)} -Action Install -Channel Candidate } catch { $failed=$true }
      if(-not $failed -or $global:downloads -lt 1){throw 'Candidate did not use gh'}
      if(Test-Path (Join-Path $env:LOCALAPPDATA 'Polycode-Candidate')){throw 'Candidate directory leaked'}
      if(@(Get-ChildItem $env:TEMP -Filter 'polycode-channel-download-*').Count){throw 'Download directory leaked'}
      'CANDIDATE_GH_FAILURE'`;
    assert.match(ok(run(runtime, script)), /CANDIDATE_GH_FAILURE/);
  });
}

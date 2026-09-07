// Explicit, interactive OAuth acceptance against an installed Windows candidate.
// No generation and no inspection/export of credential files.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { WindowsTerminal, plain } from './windows-terminal.mjs';

const [directory, provider, consent] = process.argv.slice(2);
assert.ok(directory && ['codex','cursor'].includes(provider) && consent==='--interactive-login',
  'Usage: node windows-live-login.mjs CANDIDATE codex|cursor --interactive-login');
const candidate=resolve(directory);
const manifestBytes=readFileSync(join(candidate,'manifest.json'));
const manifest=JSON.parse(manifestBytes.toString().replace(/^\uFEFF/,''));
const root=mkdtempSync(join(tmpdir(),'polycode-live-login-'));
const home=join(root,'home'), workspace=join(root,'workspace'), install=join(root,'install');
mkdirSync(home);mkdirSync(workspace);
const browserFile=join(root,'browser.txt');
const report={passed:false,provider,scope:'Actual installed Windows TUI OAuth and catalog only; no generation or clean-OS claim',
  candidateSha256:createHash('sha256').update(manifestBytes).digest('hex'),nativeSha256:manifest.native.sha256,root};
let terminal;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try {
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(candidate,'install.ps1'),
    '-AllowCandidate','-NoPath','-InstallRoot',install,'-Version',manifest.version],{encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const release=join(install,'releases',readdirSync(join(install,'releases'))[0]);
  const env={};
  for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{HOME:home,USERPROFILE:home,LOCALAPPDATA:join(home,'AppData/Local'),APPDATA:join(home,'AppData/Roaming'),
    GROK_HOME:join(home,'grok'),TERM:'xterm-256color',COLORTERM:'truecolor',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',
    GROK_TELEMETRY_ENABLED:'off',GROK_TEST_OPEN_URL_FILE:browserFile});
  terminal=new WindowsTerminal('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(release,'polycode.ps1'),
    '-Project',workspace,'-AuthDirectory',join(home,'auth'),'-Backend',provider,'--','--fullscreen','--trust'],workspace,env);
  await terminal.until(()=>plain(terminal.output).includes('Choose a provider'),90000);
  await pause(400);
  terminal.write('g'+(provider==='codex'?'j':'jj')+'\r');
  await terminal.until(()=>existsSync(browserFile)||plain(terminal.output).includes('Bridge control request failed'),30000);
  assert.ok(existsSync(browserFile),'The native OAuth start failed before opening a browser');
  const url=readFileSync(browserFile,'utf8').trim().split(/\r?\n/).at(-1);
  const parsed=new URL(url);
  assert.equal(parsed.protocol,'https:');
  assert.ok((provider==='codex'?['auth.openai.com']:['cursor.com']).includes(parsed.hostname));
  console.log(JSON.stringify({stage:'browser-login-required',provider,url,root}));
  const deadline=Date.now()+10*60*1000;
  while(!plain(terminal.output).includes('Choose a model for this native session')) {
    if(terminal.exited)throw new Error('Native TUI exited during interactive login');
    if(Date.now()>deadline)throw new Error('Interactive login did not complete within ten minutes');
    const view=plain(terminal.output);
    if(view.includes('Authorization failed during')||view.includes('Authorization timed out'))throw new Error('Native provider authorization failed; inspect the sanitized terminal evidence');
    await pause(250);
  }
  report.passed=true;
  report.catalogObserved=true;
  report.observedAt=new Date().toISOString();
} catch(error){report.failure=error.message;process.exitCode=1;}
finally {
  if(terminal){await terminal.close();report.exitCode=terminal.exitCode;report.forcedExit=!!terminal.forcedExit;
    if(terminal.forcedExit||terminal.exitCode!==0){report.passed=false;process.exitCode=1;}
    const sanitized=plain(terminal.output).replace(/https:\/\/[^\s│]+/g,value=>{try{const url=new URL(value);return url.origin+url.pathname+'[query omitted]';}catch{return '[URL omitted]';}});
    writeFileSync(join(root,'terminal.txt'),sanitized);
  }
  writeFileSync(join(root,'login-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}

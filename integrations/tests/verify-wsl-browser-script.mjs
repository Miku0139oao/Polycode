// Native Windows/WSL protocol check. Does not open a browser or authenticate.
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('../../crates/codegen/xai-grok-pager-render/src/link_opener.rs',import.meta.url),'utf8');
const script=source.match(/const WSL_BROWSER_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(script,'Rust browser script must be found');
// Shadow only the final OS dispatch. Exercise the exact production decoding,
// URI validation and variable binding, with URL metacharacters held as data.
const fixture="function Start-Process { param([string]$FilePath) [Console]::Out.Write($FilePath) }; "+script;
const encoded=Buffer.from(fixture,'utf16le').toString('base64');
const cases=[
 'https://example.invalid/oauth?state=fixture&challenge=abc%20def',
 "https://example.invalid/?x=%TEMP%&q=$(throw'INJECTED');'\"",
 'https://example.invalid/登入?名字=測試',
 'mailto:fixture@example.invalid?subject=hello%20world',
];
for(const input of cases){
 const child=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{input,encoding:'utf8',timeout:15000,windowsHide:true});
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,input);
}
for(const input of ['cmd.exe','javascript:throw(1)','file:///C:/Windows/System32/cmd.exe']){
 const child=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{input,encoding:'utf8',timeout:15000,windowsHide:true});
 assert.ifError(child.error);assert.equal(child.status,1);assert.equal(child.stdout,'');
}
console.log(JSON.stringify({passed:7,browserOpened:false,scope:'Exact PowerShell stdin/URI/dispatch binding; OS browser dispatch shadowed'}));

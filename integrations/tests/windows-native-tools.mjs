// Native Windows engine + actual native file/shell tools; model transport is a
// loopback fixture. Never counts as live provider or clean-OS acceptance.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CredentialStore, NativeProviderService } from '../native-provider/service.mjs';
import { WindowsTerminal, plain } from './windows-terminal.mjs';
import { startBunFixtureBridge } from './windows-bun-bridge.mjs';
import { fixtureUserPrompt } from './windows-native-prompts.mjs';
assert.equal(plain('\x1b]8;;file:///fixture\x1b\\link\x1b]8;;\x1b\\ Yes \x1b]0;title\x07 visible'),'link Yes  visible');
const binary = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(),'polycode-native-tools-'));
const workspace = join(root,'workspace'), home=join(root,'home');
mkdirSync(workspace); mkdirSync(home);
const nonce=randomBytes(20).toString('hex'), file=join(workspace,'fixture.txt');
writeFileSync(file,nonce);
const testMcp=process.argv.includes('--mcp');
const testTask=process.argv.includes('--task');
const testGrep=process.argv.includes('--grep');
const cleanPath=process.argv.includes('--clean-path');
const slowShell=process.argv.includes('--slow-shell');
const ripgrepIndex=process.argv.indexOf('--ripgrep');
const ripgrep=ripgrepIndex<0?null:resolve(process.argv[ripgrepIndex+1]);
const ripgrepSha256=ripgrep?createHash('sha256').update(readFileSync(ripgrep)).digest('hex'):null;
const taskState=Object.fromEntries(['codex','cursor'].map(p=>[p,{nonce:randomBytes(24).toString('hex'),childCalls:0,verified:false}]));
const mcpLog=join(root,'mcp-events.jsonl'),mcpFile=join(workspace,'mcp-fixture.txt');
const mcpNonces=Object.fromEntries(['codex','cursor'].map(p=>[p,randomBytes(24).toString('hex')]));
if(testMcp) {
  writeFileSync(mcpFile,mcpNonces.codex);
  writeFileSync(join(workspace,'.mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[fileURLToPath(new URL('./windows-mcp-fixture.mjs',import.meta.url)),mcpFile,mcpLog]}}}));
}
const store=new CredentialStore(join(home,'auth'));
const requests=[], failures=[], permissions=[];
const shellResults=[];
const shellCalls={codex:0,cursor:0};
let cancelledStreams=0;
function content(value) { return typeof value==='string'?value:Array.isArray(value)?value.map(v=>v.text||'').join('\n'):''; }
function completion(body,delta,finish='stop') {
  if (!body.stream) return Response.json({id:'fixture',object:'chat.completion',created:1,model:body.model,choices:[{index:0,message:{role:'assistant',...delta},finish_reason:finish}]});
  const chunk=(d,f=null)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:d,finish_reason:f}]})+'\n\n';
  return new Response(chunk({role:'assistant'})+chunk(delta)+chunk({},finish)+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}
function call(body,definition,args,id) {
  return completion(body,{tool_calls:[{index:0,id,type:'function',function:{name:definition.name,arguments:JSON.stringify(args)}}]},'tool_calls');
}
const providers={};
for(const provider of ['codex','cursor']) {
  await store.set(provider,{accessToken:'SYNTHETIC_ONLY'});
  providers[provider]={
    close(){}, refresh:async credential=>credential,
    models:async()=>[{id:'mock-'+provider,name:'Mock '+provider,contextWindow:provider==='cursor'?null:131072}],
    async complete(body, _credential, {signal}) {
      try {
        const prompt=fixtureUserPrompt(body.messages);
        const tools=(body.tools||[]).map(t=>t.function);
        if(tools.length===1 && tools[0].name==='session_title') return call(body,tools[0],{session_title:'Windows fixture session'},'fixture-title');
        const auxiliary=prompt.startsWith('<system-reminder>') || prompt.startsWith('CWD:') || !(body.tools||[]).length;
        if(!auxiliary && prompt.includes('WINDOWS_CHILD_REQUEST_')) {
          assert.ok(testTask,'Unexpected child request');
          const owner=['codex','cursor'].find(p=>prompt.includes('WINDOWS_CHILD_REQUEST_'+p.toUpperCase()));
          assert.equal(owner,provider,'Native Task child changed provider');
          const state=taskState[provider];
          assert.ok(state.issued,'Native Task child arrived before parent tool call');
          assert.equal(body.model,state.model,'Native Task child changed model');
          assert.equal(state.childCalls,0,'Native Task child requested twice');
          assert.ok(!JSON.stringify(body).includes(state.nonce),'Child nonce leaked before generation');
          state.childCalls++;
          return completion(body,{content:state.nonce});
        }
        const taskPrompt=!auxiliary && (prompt.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)?.[1]
          || (['Read the isolated fixture.','Read the resumed fixture.','Wait until cancelled.','Write the isolated output.','Run the isolated Windows command.','Discover and call the local MCP probe.','Run the native Task probe.','Search the isolated fixture.'].includes(prompt.trim())?prompt.trim():null));
        requests.push({provider,model:body.model,prompt:taskPrompt||'[auxiliary]',...(!taskPrompt?{promptPrefix:prompt.slice(0,240)}:{}),tools:tools.map(t=>t.name)});
        if(!taskPrompt)return completion(body,{content:'Windows fixture ready'});
        if(taskPrompt==='Search the isolated fixture.') {
          const id='grep-'+provider;
          const result=body.messages.find(m=>m.role==='tool' && m.tool_call_id===id);
          if(result) {
            assert.ok(JSON.stringify(result).includes(nonce),'Native Grep failed: '+JSON.stringify(result).slice(0,600));
            return completion(body,{content:'WINDOWS_GREP_'+provider.toUpperCase()+'_PASS'});
          }
          const definition=tools.find(t=>t.name==='grep');
          assert.ok(definition,'Native Grep tool missing');
          const args={pattern:nonce,path:file};
          assert.ok((definition.parameters.required||[]).every(key=>key in args),'Unknown required native Grep argument');
          return call(body,definition,args,id);
        }
        if(taskPrompt==='Run the native Task probe.') {
          const state=taskState[provider],id='task-'+provider;
          const results=body.messages.filter(m=>m.role==='tool' && m.tool_call_id===id);
          if(results.length) {
            assert.equal(results.length,1,'Duplicate native Task result');
            assert.equal(state.childCalls,1,'Native child did not generate its reply');
            assert.ok(content(results[0].content).includes(state.nonce),'Native Task lost child response');
            const footer=content(results[0].content).match(/<subagent_result>\s*subagent_id: ([A-Za-z0-9_-]+)\s*subagent_type: general-purpose\s*To continue this subagent's conversation, use resume_from="\1"\.\s*<\/subagent_result>/);
            assert.ok(footer,'Native Task result lacks typed resume identity');
            state.subagentId=footer[1];state.verified=true;
            return completion(body,{content:'WINDOWS_TASK_'+provider.toUpperCase()+'_PASS'});
          }
          assert.ok(!state.issued,'Native Task call was replayed');
          assert.ok(!JSON.stringify(body).includes(state.nonce),'Child response leaked before invocation');
          const definition=tools.find(t=>t.name==='spawn_subagent');
          assert.ok(definition,'Native Task tool missing');
          const args={prompt:'WINDOWS_CHILD_REQUEST_'+provider.toUpperCase()+'\nReply briefly without calling tools.',description:'Native Windows Task probe',subagent_type:'general-purpose',background:false};
          assert.ok((definition.parameters.required||[]).every(key=>key in args),'Unknown required native Task argument');
          assert.ok(Object.keys(args).every(key=>key in definition.parameters.properties),'Unknown supplied native Task argument');
          state.issued=true;state.model=body.model;
          return call(body,definition,args,id);
        }
        if(taskPrompt==='Discover and call the local MCP probe.') {
          const mcpNonce=mcpNonces[provider];
          const id='mcp-call-'+provider;
          const result=body.messages.find(m=>m.role==='tool' && m.tool_call_id===id);
          if(result) {
            assert.ok(JSON.stringify(result).includes(mcpNonce),'Native MCP result lacks fixture bytes');
            return completion(body,{content:'WINDOWS_MCP_'+provider.toUpperCase()+'_PASS'});
          }
          assert.ok(!JSON.stringify(body).includes(mcpNonce),'MCP fixture leaked before native invocation');
          const searched=body.messages.find(m=>m.role==='tool' && m.tool_call_id==='mcp-search-'+provider);
          if(searched)assert.ok(JSON.stringify(searched).includes('fixture__probe'),'MCP discovery did not find the fixture');
          const name=searched?'use_tool':'search_tool';
          const definition=tools.find(t=>t.name===name);
          assert.ok(definition,'Native MCP discovery/invocation tool missing');
          return call(body,definition,searched?{tool_name:'fixture__probe',tool_input:{}}:{query:'fixture probe'},searched?id:'mcp-search-'+provider);
        }
        if(taskPrompt==='Wait until cancelled.') {
          const stream=new ReadableStream({start(controller){
            controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:'cancel',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'WINDOWS_CANCEL_READY'},finish_reason:null}]})+'\n\n'));
            signal.addEventListener('abort',()=>{cancelledStreams++;controller.close();},{once:true});
          }});
          return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
        }
        if(['Read the isolated fixture.','Read the resumed fixture.'].includes(taskPrompt)) {
          const resumed=taskPrompt==='Read the resumed fixture.';
          const id=(resumed?'resumed-read-':'read-')+provider;
          const result=body.messages.find(m=>m.role==='tool' && m.tool_call_id===id);
          if(result) {
            assert.ok(JSON.stringify(result).includes(nonce+(resumed?'-resumed':'')),'Native Read did not return fixture bytes');
            return completion(body,{content:resumed?'WINDOWS_RESUME_PASS':'WINDOWS_READ_'+provider.toUpperCase()+'_PASS'});
          }
          const definition=tools.find(t=>['read','read_file'].includes(t.name.toLowerCase()));
          assert.ok(definition,'No advertised native read tool');
          const props=definition.parameters.properties, args={};
          const key=['target_file','file_path','path'].find(k=>k in props); assert.ok(key);
          args[key]=file;
          for(const required of definition.parameters.required||[]) {
            if(required===key) continue;
            if(['offset','start_line','start_line_one_indexed'].includes(required)) args[required]=1;
            else if(['limit','end_line','end_line_one_indexed_inclusive'].includes(required)) args[required]=20;
            else if(required==='should_read_entire_file') args[required]=true;
            else throw new Error('Unknown required native Read argument: '+required);
          }
          return call(body,definition,args,id);
        }
        if(taskPrompt==='Write the isolated output.') {
          const id='write-'+provider;
          if(body.messages.some(m=>m.role==='tool' && m.tool_call_id===id)) return completion(body,{content:'WINDOWS_WRITE_'+provider.toUpperCase()+'_PASS'});
          const definition=tools.find(t=>['write','write_file'].includes(t.name.toLowerCase()));
          assert.ok(definition,'No advertised native write tool');
          const props=definition.parameters.properties,args={};
          const pathKey=['file_path','target_file','path'].find(k=>k in props);
          const contentKey=['content','contents','file_content'].find(k=>k in props);
          assert.ok(pathKey && contentKey,'Unknown native write schema');
          args[pathKey]=join(workspace,provider+'-written.txt');
          args[contentKey]=nonce+'-'+provider;
          for(const required of definition.parameters.required||[])if(!(required in args))throw new Error('Unknown required native Write argument: '+required);
          return call(body,definition,args,id);
        }
        if(taskPrompt==='Run the isolated Windows command.') {
          const id='shell-'+provider;
          const result=body.messages.find(m=>m.role==='tool' && m.tool_call_id===id);
          if(result) {
            const outputId='shell-output-'+provider;
            const output=body.messages.find(message=>message.role==='tool' && message.tool_call_id===outputId);
            const observed=output??result;
            shellResults.push({provider,result:observed});
            if(!output && !content(result.content).includes(nonce)) {
              const taskId=content(result.content).match(/<task-id>([^<]+)<\/task-id>/)?.[1];
              assert.equal(taskId,id,'Native shell returned neither fixture bytes nor its background task');
              assert.ok(content(result.content).includes('<status>running</status>'),'Native shell background task is not running');
              const definition=tools.find(tool=>tool.name==='get_command_or_subagent_output');
              assert.ok(definition,'Native background output tool is not advertised');
              return call(body,definition,{task_ids:[taskId],timeout_ms:30000},outputId);
            }
            assert.ok(content(observed.content).includes(nonce),'Native shell did not return fixture bytes');
            if(slowShell)assert.ok(output,'Slow shell did not exercise native background output retrieval');
            return completion(body,{content:'WINDOWS_SHELL_'+provider.toUpperCase()+'_PASS'});
          }
          const definition=tools.find(t=>['bash','shell','run_shell_command','run_terminal_command'].includes(t.name.toLowerCase()));
          assert.ok(definition,'No advertised native shell tool');
          const args={command:"Get-Content -LiteralPath '"+file.replaceAll("'","''")+"'"};
          if(slowShell)args.command='Start-Sleep -Seconds 20; '+args.command;
          assert.equal(++shellCalls[provider],1,'Native shell command was issued more than once');
          for(const required of definition.parameters.required||[]) {
            if(required==='command') continue;
            if(required==='description') args[required]='Read isolated fixture using Windows PowerShell';
            else if(required==='timeout') args[required]=10000;
            else throw new Error('Unknown required native shell argument: '+required);
          }
          return call(body,definition,args,id);
        }
        return completion(body,{content:'Windows fixture ready'});
      } catch(error){failures.push(error.message);return new Response('fixture failed',{status:500});}
    },
  };
}
const service=new NativeProviderService(providers,store);
const catalogs=[];
const originalCatalog=service.catalog.bind(service);
service.catalog=async (...args)=>{const result=await originalCatalog(...args);catalogs.push(result);return result;};
const fixtureBridge=await service.start();
const bunBridge=process.argv.includes('--bun-bridge')?await startBunFixtureBridge(fixtureBridge):null;
const bridge=bunBridge??fixtureBridge;
const controlRequests=[];
service.server.on('request',(req,res)=>{
  const request={method:req.method,path:new URL(req.url,fixtureBridge.url).pathname,
    authenticated:req.headers.authorization==='Bearer '+fixtureBridge.token,
    expectedHost:req.headers.host===new URL(fixtureBridge.url).host,hasOrigin:!!req.headers.origin};
  controlRequests.push(request);res.on('finish',()=>{request.status=res.statusCode;});
});
const env={};
for(const key of ['SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{HOME:home,USERPROFILE:home,LOCALAPPDATA:join(home,'AppData/Local'),APPDATA:join(home,'AppData/Roaming'),
  GROK_HOME:join(home,'grok'),GROK_SHELL:'powershell',TERM:'xterm-256color',COLORTERM:'truecolor',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',
  GROK_TELEMETRY_ENABLED:'off',GROK_TEST_OPEN_URL_FILE:join(root,'browser.txt'),POLYCODE_BRIDGE_URL:bridge.url,POLYCODE_BRIDGE_TOKEN:bridge.token});
if(cleanPath) {
  const windows=process.env.SystemRoot||process.env.SYSTEMROOT;
  assert.ok(windows,'Windows system directory is unavailable');
  env.PATH=[join(windows,'System32'),join(windows,'System32/WindowsPowerShell/v1.0'),windows].join(';');
  delete env.GROK_SHELL;
}
if(ripgrep)env.RG_BIN_PATH=ripgrep;
const nativeArgs=['--polycode-native','--no-external-acp','--fullscreen','--trust','--cwd',workspace];
let t=new WindowsTerminal(binary,nativeArgs,workspace,env);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function text(value){await t.until(()=>plain(t.output).includes(value),90000);}
async function command(value){t.write(value+'\r');await pause(800);}
async function toolTurn(prompt,marker) {
  const mcpCalls=()=>existsSync(mcpLog)?readFileSync(mcpLog,'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(e=>e.method==='tools/call').length:0;
  const beforeMcp=prompt==='Discover and call the local MCP probe.'?mcpCalls():null;
  const offset=t.output.length;await command(prompt);
  const deadline=Date.now()+60000;let approved=false;
  while(!plain(t.output.slice(offset)).includes(marker)) {
    if(failures.length)throw new Error(failures[0]);
    if(t.exited)throw new Error('Native terminal exited during tool execution');
    if(Date.now()>deadline)throw new Error('Native tool/permission observation timed out');
    const recent=plain(t.output.slice(offset));
    const match=recent.match(/([1-9])\s+\([○●•]\)\s+Yes(?:, proceed)?(?=\s{2,}|\n|$|│)/);
    if(match && recent.includes('No, reject') && !approved){
      if(beforeMcp!==null)assert.equal(mcpCalls(),beforeMcp,'MCP executed before single-operation approval');
      permissions.push({prompt,choice:match[1],scope:'once'});t.write(match[1]);approved=true;await pause(800);
    }
    else await pause(200);
  }
  if(beforeMcp!==null){assert.ok(approved,'Native MCP execution did not request approval');assert.equal(mcpCalls(),beforeMcp+1,'MCP invocation missing or replayed');}
}
const report={passed:false,binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),scope:'Mock transport, actual Windows native TUI/tools, default leader and permissions',root};
if(bunBridge)report.bridgeRuntime={runtime:bunBridge.runtime,version:bunBridge.version,nativeServer:bunBridge.nativeServer};
function screen(){return plain(t.output);}
function lastScreen(n=4000){const s=screen();return s.length<=n?s:s.slice(-n);}
async function waitForModelPicker(provider,offset){
  const needle='mock-'+provider;
  await t.until(()=>{
    const view=plain(t.output.slice(offset));
    return view.includes('Pick model') || view.includes(needle) || view.includes('Mock '+provider);
  },90000);
  if(provider==='cursor')assert.ok(plain(t.output.slice(offset)).includes('Context capacity not provided')||plain(t.output.slice(offset)).includes('Mock cursor'));
  t.write(needle+'\r');await pause(1500);
}
async function runProviderTurns(provider){
  await command('Read the isolated fixture.');
  await text('WINDOWS_READ_'+provider.toUpperCase()+'_PASS');
  if(testGrep)await toolTurn('Search the isolated fixture.','WINDOWS_GREP_'+provider.toUpperCase()+'_PASS');
  await pause(700);
  await toolTurn('Write the isolated output.','WINDOWS_WRITE_'+provider.toUpperCase()+'_PASS');
  assert.equal(readFileSync(join(workspace,provider+'-written.txt'),'utf8'),nonce+'-'+provider);
  await pause(700);
  await toolTurn('Run the isolated Windows command.','WINDOWS_SHELL_'+provider.toUpperCase()+'_PASS');
  if(testMcp) {
    writeFileSync(mcpFile,mcpNonces[provider]);
    await pause(700);
    await toolTurn('Discover and call the local MCP probe.','WINDOWS_MCP_'+provider.toUpperCase()+'_PASS');
  }
  if(testTask) {
    await pause(700);
    await toolTurn('Run the native Task probe.','WINDOWS_TASK_'+provider.toUpperCase()+'_PASS');
    assert.ok(taskState[provider].verified);
  }
}
try {
  await text('Choose a provider');
  // The first menu renders before its asynchronous catalog arrives. Dismissing
  // it early cancels that refresh and can incorrectly exercise OAuth instead.
  await text('choose a model (use /login to sign in again)');
  // Stay on the startup card (1 Grok, 2 ChatGPT, 3 Cursor). Esc+/provider was
  // racing the catalog→models.available merge and never opened "Pick model".
  let offset=t.output.length;
  t.write('2');
  await waitForModelPicker('codex',offset);
  await runProviderTurns('codex');
  t.write('\x1b');await pause(500);
  offset=t.output.length;
  await command('/provider');
  await t.until(()=>plain(t.output.slice(offset)).includes('Choose a provider'),30000);
  t.write('3');
  await waitForModelPicker('cursor',offset);
  await runProviderTurns('cursor');
  if(testMcp) {
    const events=readFileSync(mcpLog,'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.filter(e=>e.method==='tools/call').length,2,'MCP calls missing or replayed');
    assert.ok(events.some(e=>e.event==='environment'),'MCP environment observation missing');
    assert.ok(events.filter(e=>e.event==='environment').every(e=>!e.bridgeTokenPresent),'Bridge token leaked to MCP subprocess');
    report.mcp={calls:2,bridgeTokenLeaked:false};
  }
  if(testTask)report.nativeTasks=Object.fromEntries(Object.entries(taskState).map(([provider,state])=>[provider,{childCalls:state.childCalls,verified:state.verified,model:state.model,subagentId:state.subagentId}]));
  if(testGrep)report.grep={providers:['codex','cursor'],cleanPath,ripgrepSha256};
  await pause(1000);
  await command('Wait until cancelled.');
  await text('WINDOWS_CANCEL_READY');
  t.write('\x03');
  await t.until(()=>cancelledStreams===1,15000);
  assert.equal(t.exited,false,'Cancellation exited the native TUI');
  report.cancelledStreams=cancelledStreams;
  await pause(1500);
  await t.close();
  report.firstTerminalCloseMs=t.closeMs;
  assert.ok(!t.forcedExit && t.exitCode===0,'First terminal did not exit normally');
  const session=plain(t.output).match(/--resume\s+([a-f0-9-]{36})/)?.[1];
  assert.ok(session,'Native TUI did not expose a resumable session');
  const sessionsRoot=join(home,'grok','sessions');
  const summaryPath=readdirSync(sessionsRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory())
    .map(entry=>join(sessionsRoot,entry.name,session,'summary.json')).find(existsSync);
  assert.ok(summaryPath,'Persisted native session summary is missing');
  report.persistedModelId=JSON.parse(readFileSync(summaryPath,'utf8')).current_model_id;
  assert.equal(report.persistedModelId,'cursor/mock-cursor','Persistence lost the selected provider identity');
  writeFileSync(join(root,'first-terminal.txt'),plain(t.output).replaceAll(bridge.token,'[REDACTED]'));
  writeFileSync(file,nonce+'-resumed');
  t=new WindowsTerminal(binary,[...nativeArgs,'--resume',session],workspace,env);
  await text('Mock cursor');
  await pause(1000);
  await command('Read the resumed fixture.');
  await text('WINDOWS_RESUME_PASS');
  report.resumedSession=session;
  assert.deepEqual(failures,[]);
  report.passed=true;
} catch(error){report.failure=error.message;report.screen=lastScreen();process.exitCode=1;}
finally {
  await t.close();if(bunBridge)await bunBridge.close();await service.close();
  report.forcedExit=!!t.forcedExit;
  report.lastTerminalCloseMs=t.closeMs;
  if(t.forcedExit){report.passed=false;process.exitCode=1;}
  // The pager flushes "pager quit" before tearing down the terminal, so the unified log
  // separates a Ctrl+Q that never became Quit from a Quit whose teardown outlived the harness.
  const unifiedLog=join(home,'grok','logs','unified.jsonl');
  if(existsSync(unifiedLog)){
    const entries=readFileSync(unifiedLog,'utf8').replaceAll(bridge.token,'[REDACTED]');
    writeFileSync('windows-tools-unified.jsonl',entries);
    report.pagerQuitLogged=entries.includes('"pager quit"');
  } else report.pagerQuitLogged=null;
  report.requests=requests;report.permissions=permissions;report.controlRequests=controlRequests;report.catalogs=catalogs;report.fixtureErrors=failures;
  report.shellResults=JSON.parse(JSON.stringify(shellResults).replaceAll(bridge.token,'[REDACTED]'));
  report.shellCalls=shellCalls;report.slowShell=slowShell;
  writeFileSync(join(root,'terminal.txt'),plain(t.output).replaceAll(bridge.token,'[REDACTED]'));
  writeFileSync('windows-tools-terminal.txt',plain(t.output).replaceAll(bridge.token,'[REDACTED]'));
  writeFileSync('windows-tools-report.json',JSON.stringify(report,null,2)+'\n');
  writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,failure:report.failure,root}));
}

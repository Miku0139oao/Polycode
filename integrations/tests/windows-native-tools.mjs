// Native Windows engine + actual native file/shell tools; model transport is a
// loopback fixture. Never counts as live provider or clean-OS acceptance.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { CredentialStore, NativeProviderService } from '../native-provider/service.mjs';
import { WindowsTerminal, plain } from './windows-terminal.mjs';
assert.equal(plain('\x1b]8;;file:///fixture\x1b\\link\x1b]8;;\x1b\\ Yes \x1b]0;title\x07 visible'),'link Yes  visible');
const binary = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(),'polycode-native-tools-'));
const workspace = join(root,'workspace'), home=join(root,'home');
mkdirSync(workspace); mkdirSync(home);
const nonce=randomBytes(20).toString('hex'), file=join(workspace,'fixture.txt');
writeFileSync(file,nonce);
const store=new CredentialStore(join(home,'auth'));
const requests=[], failures=[], permissions=[];
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
        const last=[...(body.messages||[])].reverse().find(m=>m.role==='user'), prompt=content(last?.content);
        const auxiliary=prompt.startsWith('<system-reminder>') || prompt.startsWith('CWD:') || !(body.tools||[]).length;
        const taskPrompt=!auxiliary && (prompt.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)?.[1]
          || (['Read the isolated fixture.','Read the resumed fixture.','Wait until cancelled.','Write the isolated output.','Run the isolated Windows command.'].includes(prompt.trim())?prompt.trim():null));
        const tools=(body.tools||[]).map(t=>t.function);
        requests.push({provider,model:body.model,prompt:taskPrompt||'[auxiliary]',...(!taskPrompt?{promptPrefix:prompt.slice(0,240)}:{}),tools:tools.map(t=>t.name)});
        if(tools.length===1 && tools[0].name==='session_title') return call(body,tools[0],{session_title:'Windows fixture session'},'fixture-title');
        if(!taskPrompt)return completion(body,{content:'Windows fixture ready'});
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
            assert.ok(JSON.stringify(result).includes(nonce),'Native shell did not return fixture bytes');
            return completion(body,{content:'WINDOWS_SHELL_'+provider.toUpperCase()+'_PASS'});
          }
          const definition=tools.find(t=>['bash','shell','run_shell_command','run_terminal_command'].includes(t.name.toLowerCase()));
          assert.ok(definition,'No advertised native shell tool');
          const args={command:"Get-Content -LiteralPath '"+file.replaceAll("'","''")+"'"};
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
const bridge=await service.start();
const controlRequests=[];
service.server.on('request',(req,res)=>{
  const request={method:req.method,path:new URL(req.url,bridge.url).pathname,
    authenticated:req.headers.authorization==='Bearer '+bridge.token,
    expectedHost:req.headers.host===new URL(bridge.url).host,hasOrigin:!!req.headers.origin};
  controlRequests.push(request);res.on('finish',()=>{request.status=res.statusCode;});
});
const env={};
for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{HOME:home,USERPROFILE:home,LOCALAPPDATA:join(home,'AppData/Local'),APPDATA:join(home,'AppData/Roaming'),
  GROK_HOME:join(home,'grok'),GROK_SHELL:'powershell',TERM:'xterm-256color',COLORTERM:'truecolor',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',
  GROK_TELEMETRY_ENABLED:'off',GROK_TEST_OPEN_URL_FILE:join(root,'browser.txt'),POLYCODE_BRIDGE_URL:bridge.url,POLYCODE_BRIDGE_TOKEN:bridge.token});
const nativeArgs=['--polycode-native','--no-external-acp','--fullscreen','--trust','--cwd',workspace];
let t=new WindowsTerminal(binary,nativeArgs,workspace,env);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function text(value){await t.until(()=>plain(t.output).includes(value),90000);}
async function command(value){t.write(value+'\r');await pause(800);}
async function toolTurn(prompt,marker) {
  const offset=t.output.length;await command(prompt);
  const deadline=Date.now()+60000;let approved=false;
  while(!plain(t.output.slice(offset)).includes(marker)) {
    if(failures.length)throw new Error(failures[0]);
    if(t.exited)throw new Error('Native terminal exited during tool execution');
    if(Date.now()>deadline)throw new Error('Native tool/permission observation timed out');
    const recent=plain(t.output.slice(offset));
    const match=recent.match(/([1-9])\s+\([○●•]\)\s+Yes(?:, proceed)?(?=\s{2,}|\n|$|│)/);
    if(match && recent.includes('No, reject') && !approved){permissions.push({prompt,choice:match[1],scope:'once'});t.write(match[1]);approved=true;await pause(800);}
    else await pause(200);
  }
}
const report={passed:false,binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),scope:'Mock transport, actual Windows native TUI/tools, default leader and permissions',root};
try {
  await text('Choose a provider');
  for(const provider of ['codex','cursor']) {
    t.write('\x1b');await pause(500);
    const offset=t.output.length;
    await command('/provider '+provider);
    await t.until(()=>plain(t.output.slice(offset)).includes('Choose a model for this native session'),30000);
    if(provider==='cursor')assert.ok(plain(t.output.slice(offset)).includes('Context capacity not provided'));
    t.write('g\r');await pause(1500);
    await command('Read the isolated fixture.');
    await text('WINDOWS_READ_'+provider.toUpperCase()+'_PASS');
    await pause(700);
    await toolTurn('Write the isolated output.','WINDOWS_WRITE_'+provider.toUpperCase()+'_PASS');
    assert.equal(readFileSync(join(workspace,provider+'-written.txt'),'utf8'),nonce+'-'+provider);
    await pause(700);
    await toolTurn('Run the isolated Windows command.','WINDOWS_SHELL_'+provider.toUpperCase()+'_PASS');
  }
  await pause(1000);
  await command('Wait until cancelled.');
  await text('WINDOWS_CANCEL_READY');
  t.write('\x03');
  await t.until(()=>cancelledStreams===1,15000);
  assert.equal(t.exited,false,'Cancellation exited the native TUI');
  report.cancelledStreams=cancelledStreams;
  await pause(1500);
  await t.close();
  assert.ok(!t.forcedExit && t.exitCode===0,'First terminal did not exit normally');
  const session=plain(t.output).match(/--resume\s+([a-f0-9-]{36})/)?.[1];
  assert.ok(session,'Native TUI did not expose a resumable session');
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
} catch(error){report.failure=error.message;process.exitCode=1;}
finally {
  await t.close();await service.close();
  report.forcedExit=!!t.forcedExit;
  if(t.forcedExit){report.passed=false;process.exitCode=1;}
  report.requests=requests;report.permissions=permissions;report.controlRequests=controlRequests;report.catalogs=catalogs;report.fixtureErrors=failures;
  writeFileSync(join(root,'terminal.txt'),plain(t.output).replaceAll(bridge.token,'[REDACTED]'));
  writeFileSync('windows-tools-report.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,failure:report.failure,root}));
}

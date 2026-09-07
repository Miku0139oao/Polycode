// Local stdio fixture owned by the native MCP manager. Never log credentials.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [fixture, log] = process.argv.slice(2);
const record = value => appendFileSync(log, JSON.stringify(value)+'\n');
record({event:'environment',bridgeTokenPresent:!!process.env.POLYCODE_BRIDGE_TOKEN});
for await (const line of createInterface({input:process.stdin})) {
  const request=JSON.parse(line);
  if(!('id' in request))continue;
  const {method,params={}}=request;
  record({event:'request',method});
  let result;
  if(method==='initialize')result={protocolVersion:params.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'windows-fixture',version:'1.0'}};
  else if(method==='tools/list')result={tools:[{name:'probe',description:'Read the native fixture probe value.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}}]};
  else if(method==='tools/call' && params.name==='probe' && Object.keys(params.arguments||{}).length===0)result={content:[{type:'text',text:readFileSync(fixture,'utf8')}],isError:false};
  else if(method==='ping')result={};
  else if(['resources/list','prompts/list'].includes(method))result={[method.split('/')[0]]:[]};
  const response=result===undefined?{error:{code:-32601,message:'Unsupported fixture request'}}:{result};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,...response})+'\n');
}

#!/usr/bin/env python3
"""Native Task + child/Session resume against REAL subscription transports (opt-in).

No login or browser automation lives here. OAuth is owned by the parent and is
currently reported broken for Cursor only; ChatGPT and native Grok work. --preflight never reads credentials
or starts the service/TUI. It cannot pass the real acceptance gate.

After the parent fixes/reproduces OAuth, coordinates budget and supplies a NEW
explicitly authorized app-owned auth directory from the parent-owned login flow:
  python3 native_task_live.py /absolute/native --preflight --artifacts /new/preflight
  python3 native_task_live.py /absolute/native --allow-subscription-usage \
    --auth-directory /parent/authorized/auth --providers codex \
    --artifacts /new/live
Use --providers both only after Cursor is repaired and separately authorized.
Optional --codex-model/--cursor-model select exact wire IDs; otherwise choose the
first actual advertised model and record/require that exact model on every child
and resumed Session request. Never copy credential stores. Only normal
CredentialStore accesses the authorized app-owned files and may rotate tokens.
The runner refuses to start while this native binary has an active process.
Only report.json and events.jsonl are retained; private histories/nonces and the
unmodified real transport observer module are temporary and deleted on exit.
No raw PTY, OAuth URLs, credential values or model bodies are published.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from types import SimpleNamespace

from native_live import native_child
from native_pty import Terminal, isolated_environment, native_preflight, permission_key

# Runtime instrumentation only: real providers produce EVERY response and the
# native Agent executes EVERY tool. No synthetic SSE, external agent CLI, or
# mock provider is substituted. Buffering a bounded response lets us reject
# unexpected tool execution before any tool-call bytes reach the native Agent.
OBSERVER = r'''
import {readFileSync, writeFileSync, appendFileSync, existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (process.env.POLYCODE_LIVE_USAGE_CONSENT !== 'yes') throw Error('consent_required');
const {runNative} = await import(pathToFileURL(cfg.modules + '/launch.mjs'));
const {createCodexProvider} = await import(pathToFileURL(cfg.modules + '/codex.mjs'));
const {createCursorProvider} = await import(pathToFileURL(cfg.modules + '/cursor/index.mjs'));
const state = existsSync(cfg.state) ? JSON.parse(readFileSync(cfg.state, 'utf8')) : {requests:0, phases:{}, models:{}};
const record = data => { appendFileSync(cfg.events, JSON.stringify(data) + '\n', {mode:0o600}); writeFileSync(cfg.state, JSON.stringify(state), {mode:0o600}); };
const require = (condition, code) => { if (!condition) { record({kind:'contract_failure', code}); throw Error(code); } };
const text = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
const footer = content => {
  const ids = [...text(content).matchAll(/<subagent_result>\s*subagent_id: ([A-Za-z0-9_-]+)\s*subagent_type: general-purpose\s*To continue this subagent's conversation, use resume_from="\1"\.\s*<\/subagent_result>/g)];
  require(ids.length === 1, 'unique_typed_child_id_required'); return ids[0][1];
};
const auxiliary = b => {
  const tools = b.tools ?? [], ms = b.messages ?? [], last = text(ms.findLast(m => m.role === 'user')?.content);
  return (tools.length === 1 && tools[0].function?.name === 'session_title' && b.tool_choice?.function?.name === 'session_title') ||
    (!tools.length && text(ms.find(m => m.role === 'system')?.content).startsWith('You predict the next line the USER will type into their coding agent.')) ||
    last.startsWith('<system-reminder>Generate a session title for the conversation above.') ||
    last.startsWith("<system-reminder>Write an ultra-short dashboard line that captures the AGENT'S REPLY");
};
const canonical = x => JSON.stringify(x, function(k,v) { return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key,v[key]])) : v; });
const sameFunction = (a,b) => a?.name === b?.name && canonical(JSON.parse(a.arguments)) === canonical(JSON.parse(b.arguments));
function correlated(ms, id, name) {
  const calls = ms.flatMap((m,i) => m.role === 'assistant' ? (m.tool_calls ?? []).filter(c => c.id === id).map(c => [i,c]) : []);
  const results = ms.flatMap((m,i) => m.role === 'tool' && m.tool_call_id === id ? [[i,m]] : []);
  require(calls.length === 1 && results.length === 1, 'unique_correlated_call_and_result_required');
  const [ci, call] = calls[0], [ri, result] = results[0];
  require(ci < ri && ms.findLastIndex((m,i) => i < ri && m.role === 'assistant') === ci, 'correlated_call_order');
  require(call.type === 'function' && call.function?.name === name, 'correlated_tool_name');
  return {call, result, ci, ri};
}
function inspectRequest(provider, body, credential) {
  require(++state.requests <= cfg.maxRequests, 'subscription_request_budget_exhausted');
  const serialized = JSON.stringify(body), ms = body.messages ?? [];
  require(![credential.accessToken, credential.refreshToken].some(v => typeof v === 'string' && v.length > 16 && serialized.includes(v)), 'credential_in_model_prompt');
  require(body.stream === true, 'stream_required');
  if (auxiliary(body)) { record({kind:'request', purpose:'auxiliary', provider, model:body.model}); return null; }
  require(provider === cfg.provider && body.model === state.models[provider], 'exact_provider_model_continuity');
  const last = text(ms.findLast(m => m.role === 'user')?.content), p = cfg.probes[provider];
  let phase, purpose;
  if (last.startsWith(p.initial.parentMarker)) { phase = 'initial'; purpose = 'parent'; }
  else if (last.startsWith(p.resume.parentMarker)) { phase = 'resume'; purpose = 'parent'; }
  else if (last.startsWith(p.sessionMarker)) { phase = 'session'; purpose = 'parent'; }
  else if (last.startsWith(p.initial.childMarker)) { phase = 'initial'; purpose = 'child'; }
  else if (last.startsWith(p.resume.childMarker)) { phase = 'resume'; purpose = 'child'; }
  else { require(false, 'unexpected_nonauxiliary_request'); }
  const key = provider + ':' + phase;
  const s = state.phases[key] ??= {childRequests:0, readVerified:false, verified:false};
  const prior = state.phases[provider + ':initial'];
  if (phase === 'session') {
    require(cfg.resume && prior?.verified && state.phases[provider + ':resume']?.verified, 'session_requires_completed_children');
    for (const name of ['initial', 'resume']) {
      const prev = state.phases[provider + ':' + name];
      const {result} = correlated(ms, prev.call.id, 'spawn_subagent');
      require(footer(result.content) === prev.id && text(result.content).includes(p[name].nonce), 'session_lost_child_result_history');
      require(ms.slice(0,-1).some(m => m.role === 'user' && text(m.content).startsWith(p[name].parentMarker)), 'session_lost_user_history');
    }
    s.verified = true;
    record({kind:'session_history', provider, model:body.model, session_id:cfg.resume, verified:true});
  } else if (purpose === 'child') {
    require(s.call && !s.verified, 'unsolicited_or_late_child');
    if (phase === 'resume') {
      require(prior?.verified && ms.slice(0,-1).some(m => m.role === 'user' && text(m.content).startsWith(p.initial.childMarker)), 'child_lost_original_user_history');
      require(ms.slice(0,-1).some(m => m.role === 'assistant' && text(m.content).includes(p.initial.nonce)), 'child_lost_original_assistant_history');
      s.historyVerified = true;
    }
    const nonceResults = ms.filter(m => m.role === 'tool' && text(m.content).includes(p[phase].nonce));
    if (nonceResults.length) {
      require(nonceResults.length === 1 && s.readCall, 'unique_child_read_result');
      const {call, result} = correlated(ms, s.readCall.id, s.readCall.function.name);
      require(sameFunction(call.function, s.readCall.function), 'child_read_arguments_changed');
      require(text(result.content).includes(p[phase].nonce), 'child_read_nonce_missing');
      s.readVerified = true;
    } else require(!serialized.includes(p[phase].nonce), 'child_nonce_leaked_before_native_read');
    s.childRequests++;
  } else {
    const lastUser = ms.findLastIndex(m => m.role === 'user');
    const calls = ms.slice(lastUser + 1).flatMap(m => m.tool_calls ?? []);
    const results = ms.slice(lastUser + 1).filter(m => m.role === 'tool');
    if (results.length || calls.length) {
      require(calls.length === 1 && results.length === 1 && s.call, 'one_parent_task_only');
      const {call, result, ci} = correlated(ms, s.call.id, 'spawn_subagent');
      require(ci > lastUser && sameFunction(call.function, s.call.function), 'parent_task_arguments_changed');
      require(s.childRequests >= 2 && s.readVerified && text(result.content).includes(p[phase].nonce), 'native_child_nonce_roundtrip_required');
      s.id = footer(result.content);
      if (phase === 'resume') require(s.historyVerified && s.id !== prior.id, 'resumed_child_new_id_and_history_required');
      require(!s.verified, 'duplicate_parent_completion'); s.verified = true;
      record({kind:'task_result', provider, model:body.model, phase, child_id:s.id, resume_from:phase === 'resume' ? prior.id : null, verified:true, history_verified:!!s.historyVerified});
    } else require(!serialized.includes(p[phase].nonce), 'parent_nonce_leaked_before_child');
  }
  record({kind:'request', provider, model:body.model, phase, purpose, child_requests:s.childRequests});
  return {provider, phase, purpose, s, p, prior, body};
}
async function inspectResponse(response, probe) {
  // Preserve actual provider bytes; never manufacture completions or tool results.
  const reader = response.body?.getReader(), chunks = []; let size = 0;
  if (reader) try { for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length; require(size <= 524288, 'response_size_bound'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks);
  record({kind:'real_response', provider:cfg.provider, status:response.status, bytes:size, sha256:createHash('sha256').update(bytes).digest('hex')});
  if (response.ok && probe) {
    const {provider,phase,purpose,s,p,prior,body} = probe, calls = new Map(); let answer = '', finish = null;
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue;
      const choice = JSON.parse(line.slice(6)).choices?.[0]; if (!choice) continue;
      answer += choice.delta?.content ?? ''; if (choice.finish_reason) finish = choice.finish_reason;
      for (const part of choice.delta?.tool_calls ?? []) {
        const c = calls.get(part.index) ?? {id:'',type:'function',function:{name:'',arguments:''}};
        if (part.id) c.id = part.id; if (part.function?.name) c.function.name += part.function.name;
        c.function.arguments += part.function?.arguments ?? ''; calls.set(part.index,c);
      }
    }
    require(finish === (calls.size ? 'tool_calls' : 'stop'), 'complete_real_sse_required');
    if (calls.size) {
      require(phase !== 'session' && calls.size === 1, 'one_allowed_native_tool_only');
      const call = [...calls.values()][0], a = JSON.parse(call.function.arguments);
      if (purpose === 'parent') {
        require(!s.call && !s.verified && call.function.name === 'spawn_subagent', 'native_spawn_only_once');
        const keys = ['background','description','prompt','subagent_type', ...(phase === 'resume' ? ['resume_from'] : [])].sort();
        require(JSON.stringify(Object.keys(a).sort()) === JSON.stringify(keys), 'no_model_cwd_or_other_overrides');
        require(a.background === false && a.subagent_type === 'general-purpose' && a.prompt === p[phase].childPrompt && a.description === p[phase].description, 'exact_native_child_arguments');
        if (phase === 'resume') require(prior?.verified && a.resume_from === prior.id, 'actual_returned_resume_id_required');
        require((body.tools ?? []).some(t => t.function?.name === 'spawn_subagent'), 'advertised_spawn_required');
        s.call = call;
        record({kind:'task_issued', provider, model:body.model, phase, resume_from:a.resume_from ?? null});
      } else {
        require(!s.readCall && /^(read_file|Read)$/.test(call.function.name), 'child_native_read_only_once');
        const path = a.path ?? a.file_path ?? a.target_file;
        require(path === p[phase].file, 'exact_child_fixture_path'); s.readCall = call;
      }
    } else {
      require(phase === 'session' || (purpose === 'parent' ? s.verified : s.readVerified), 'real_native_result_before_answer');
      const nonce = phase === 'session' ? p.resume.nonce : p[phase].nonce;
      require(answer.includes(nonce), 'real_answer_nonce_required');
      if (phase === 'resume' && purpose === 'child') require(answer.includes(p.initial.nonce), 'resumed_answer_original_nonce_required');
      record({kind:'answer', provider, model:body.model, phase, purpose});
    }
  }
  return new Response(bytes, {status:response.status, headers:response.headers});
}
const factories = {codex:createCodexProvider,cursor:createCursorProvider};
const providers = Object.fromEntries(cfg.providers.map(id => [id, factories[id]()]).map(([id,p]) => [id, {...p,
  async startLogin() { require(false, 'authorization_owned_by_parent'); },
  async models(credential, context) {
    const models = await p.models(credential, context);
    const selected = state.models[id] ?? cfg.models[id] ?? models[0]?.id;
    require(models.some(m => m.id === selected), 'selected_model_unavailable'); state.models[id] = selected;
    record({kind:'catalog', provider:id, models:models.map(m => m.id), selected_model:selected}); return models;
  },
  async complete(body, credential, context) {
    const probe = inspectRequest(id, body, credential);
    record({kind:'real_dispatch', provider:id, model:body.model});
    return inspectResponse(await p.complete(body, credential, context), probe);
  }
}]));
runNative({binary:cfg.binary,cwd:cfg.workspace,directory:cfg.auth,providers,resume:cfg.resume,
  nativeArgs:['--fullscreen','--trust']}).then(code => process.exit(code), () => {record({kind:'startup_failure'}); process.exit(1);});
'''


def read_events(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def session_evidence(home, marker, model):
    """Read only this run's disposable native persistence, never auth stores."""
    matches = []
    for path in (home / '.grok' / 'sessions').rglob('summary.json'):
        history = path.with_name('chat_history.jsonl')
        if history.exists() and marker in history.read_text():
            summary = json.loads(path.read_text())
            if summary.get('session_kind') not in ('subagent', 'subagent_fork'):
                assert summary.get('current_model_id') == model, 'persisted provider/model changed'
                matches.append(path.parent.name)
    assert len(matches) == 1, 'expected one native parent Session with original history'
    return matches[0]


def make_probes(workspace):
    probes = {}
    for provider in ('codex', 'cursor'):
        probe = {'sessionMarker': f'NATIVE_LIVE_SESSION_{provider.upper()}'}
        for phase in ('initial', 'resume'):
            nonce = 'native-task-secret-' + os.urandom(24).hex()
            file = workspace / f'{provider}-{phase}.txt'
            file.write_text(nonce + '\n')
            marker = f'NATIVE_LIVE_CHILD_{provider.upper()}_{phase.upper()}'
            child = (marker + f'\nUse only your native Read/read_file tool to read {file}. '
                     + ('Also recall your original reply from your prior conversation. ' if phase == 'resume' else '')
                     + 'Reply with the complete file contents' + (' and your original reply' if phase == 'resume' else '') + '. Do not use shell or web tools.')
            probe[phase] = {'nonce': nonce, 'file': str(file), 'childMarker': marker,
                            'parentMarker': f'NATIVE_LIVE_PARENT_{provider.upper()}_{phase.upper()}',
                            'description': f'Native {provider} Task {"resume " if phase == "resume" else ""}probe',
                            'childPrompt': child}
        probes[provider] = probe
    return probes


def task_prompt(probe, phase, child_id=None):
    p = probe[phase]
    args = {'prompt': p['childPrompt'], 'description': p['description'],
            'subagent_type': 'general-purpose', 'background': False}
    if phase == 'resume':
        assert child_id and re.fullmatch(r'[A-Za-z0-9_-]+', child_id)
        args['resume_from'] = child_id
    return (p['parentMarker'] + '\nCall your native spawn_subagent exactly once with precisely these JSON arguments: '
            + json.dumps(args) + '\nDo not add model, cwd, or any overrides. Do not read files yourself. '
            'After its foreground result returns, reply with its answer, including the complete file contents. No other tools.')


def wait_safe(t, events_file, predicate, description, timeout=180):
    def checked():
        events = read_events(events_file)
        assert not any(e['kind'] in ('contract_failure', 'startup_failure') for e in events), 'live native contract failed (redacted events)'
        return predicate(events)
    t.wait(checked, description, timeout)


def active_native_processes(binary, proc=Path('/proc')):
    matches = []
    for path in proc.iterdir():
        if path.name.isdigit():
            try:
                if (path / 'exe').resolve() == binary:
                    matches.append(int(path.name))
            except (FileNotFoundError, PermissionError):
                pass
    return matches


def live_command(bun, module, config):
    return [str(bun), str(module), str(config)]


def run(args, artifacts):
    report = {'passed': False, 'real_accounts': False, 'provider_service_started': False,
              'subscription_usage_authorized': not args.preflight,
              'authorization': 'ChatGPT usage authorized only with parent-specified app authdir; Cursor OAuth still needs parent repair/authorization',
              'browser_opened': False, 'providers': {p: {k: 'BLOCKED' for k in ('inheritance', 'result', 'child_resume', 'session_resume')}
                                                   for p in ('codex', 'cursor')}}
    stage = 'offline_preflight'
    t = None
    # Keep all runner outputs in the explicitly chosen worktree artifact directory.
    with tempfile.TemporaryDirectory(prefix='private-', dir=artifacts) as temp:
        root = Path(temp)
        workspace = root / 'workspace'
        workspace.mkdir()
        env = isolated_environment(root, SimpleNamespace(url='', token=''), default_features=True)
        env.pop('POLYCODE_BRIDGE_URL')
        env.pop('POLYCODE_BRIDGE_TOKEN')
        try:
            binary = args.binary.resolve(strict=True)
            native_preflight(binary, env)
            with binary.open('rb') as executable:
                report['binary_sha256'] = hashlib.file_digest(executable, 'sha256').hexdigest()
            report['binary'] = str(binary)
            module = root / 'observer.mjs'
            module.write_text(OBSERVER)
            subprocess.run([str(args.bun), 'build', str(module), '--target=bun', '--external', '*',
                            '--outfile', str(root / 'syntax-only.mjs')], env=env, check=True,
                           capture_output=True, timeout=20)
            report['observer_syntax'] = 'PASS'
            if args.preflight:
                report['offline_preflight'] = 'PASS (no TUI, credentials, browser or subscription service started)'
                return report
            stage = 'active_user_session_collision'
            active = active_native_processes(binary)
            if active:
                report['blocking_native_pids'] = active
                raise RuntimeError('parent must coordinate active native session before live run')
            stage = 'authorized_auth_precondition'
            auth = args.auth_directory.resolve(strict=True)
            selected_providers = ['codex', 'cursor'] if args.providers == 'both' else [args.providers]
            report['selected_providers'] = selected_providers
            # Existence checks only; the real CredentialStore alone reads credentials.
            assert all((auth / (p + '.json')).is_file() for p in selected_providers), 'parent must complete selected app-owned logins first'
            env['POLYCODE_LIVE_USAGE_CONSENT'] = 'yes'
            probes = make_probes(workspace)
            events_file = artifacts / 'events.jsonl'
            config_file = root / 'config.json'
            cfg = {'binary': str(binary), 'modules': str(Path(__file__).resolve().parent.parent / 'native-provider'),
                   'workspace': str(workspace), 'auth': str(auth), 'events': str(events_file),
                   'state': str(root / 'state.json'), 'probes': probes, 'maxRequests': args.max_requests, 'providers': selected_providers,
                   'models': {'codex': args.codex_model, 'cursor': args.cursor_model}}
            for provider in selected_providers:
                stage = provider + ':startup'
                cfg.update(provider=provider, resume=None)
                config_file.write_text(json.dumps(cfg))
                t = Terminal(live_command(args.bun, module, config_file), env, workspace)
                report.update(real_accounts=True, provider_service_started=True)
                t.text('Choose a provider', timeout=90)
                assert t.screen.alt_screen
                native_pid = native_child(t, binary)
                t.escape()
                t.command('/provider ' + provider)
                t.text('Choose a model for this native session', timeout=60)
                catalogs = [e for e in read_events(events_file) if e['kind'] == 'catalog' and e['provider'] == provider]
                assert catalogs, 'actual provider catalog absent'
                cfg['models'][provider] = catalogs[-1]['selected_model']
                assert cfg['models'][provider] in catalogs[-1]['models'], 'selected exact model absent'
                t.choose(catalogs[-1]['models'].index(cfg['models'][provider]))
                ids = {}
                for phase in ('initial', 'resume'):
                    stage = provider + ':' + phase
                    p = probes[provider][phase]
                    t.command(task_prompt(probes[provider], phase, ids.get('initial')))
                    heading = 'Allow ' + p['description'] + '?'
                    wait_safe(t, events_file, lambda es: heading in t.screen.text() and permission_key(t.screen.text(), 'Yes') is not None,
                              'exact Task single-use permission')
                    pending = lambda es: [e for e in es if e['kind'] == 'request' and e.get('provider') == provider and e.get('phase') == phase and e.get('purpose') == 'child']
                    assert not pending(read_events(events_file)), 'child executed before single-use approval'
                    t.pump(.3)
                    assert heading in t.screen.text() and not pending(read_events(events_file)), 'permission pending invariant'
                    key = permission_key(t.screen.text(), 'Yes')
                    assert key is not None
                    report.setdefault('permissions', []).append({'provider': provider, 'phase': phase,
                                                                 'pending_child_requests': 0, 'label': 'Yes', 'key': key.decode()})
                    t.send(key)
                    def results(es):
                        return [e for e in es if e['kind'] == 'task_result' and e['provider'] == provider and e['phase'] == phase]
                    wait_safe(t, events_file, lambda es: len(results(es)) == 1, 'native correlated Task result')
                    result = results(read_events(events_file))[0]
                    ids[phase] = result['child_id']
                    t.text(p['nonce'], timeout=180)
                    wait_safe(t, events_file, lambda es: any(e['kind'] == 'answer' and e['provider'] == provider and e['phase'] == phase and e['purpose'] == 'parent' for e in es), 'real parent answer')
                    assert native_child(t, binary) == native_pid, 'TUI process replaced during child flow'
                    report['providers'][provider].update(model=cfg['models'][provider], native_pid=native_pid, child_id=ids['initial'])
                    report['providers'][provider].update({'inheritance': 'PASS', 'result': 'PASS'} if phase == 'initial' else {'child_resume': 'PASS', 'resumed_child_id': ids['resume']})
                    t.pump(1)
                stage = provider + ':session_persistence'
                sid = session_evidence(root / 'home', probes[provider]['initial']['parentMarker'], provider + '/' + cfg['models'][provider])
                report['providers'][provider]['session_id'] = sid
                t.close()
                t = None
                cfg['resume'] = sid
                config_file.write_text(json.dumps(cfg))
                stage = provider + ':session_resume'
                t = Terminal(live_command(args.bun, module, config_file), env, workspace)
                # A new actual TUI process loads the SAME native Session from its
                # persisted ID, without /provider, model flags or bootstrap edits.
                t.text(probes[provider]['resume']['nonce'], timeout=90)
                assert t.screen.alt_screen
                resumed_pid = native_child(t, binary)
                t.command(probes[provider]['sessionMarker'] + '\nRecall the last resumed child answer from this Session history and repeat it. Do not use tools.')
                wait_safe(t, events_file, lambda es: any(e['kind'] == 'session_history' and e['provider'] == provider and e['session_id'] == sid for e in es), 'same Session provider/model/history on real transport')
                wait_safe(t, events_file, lambda es: any(e['kind'] == 'answer' and e['provider'] == provider and e['phase'] == 'session' for e in es), 'resumed Session real answer')
                t.text(probes[provider]['resume']['nonce'], timeout=180)
                assert session_evidence(root / 'home', probes[provider]['initial']['parentMarker'], provider + '/' + cfg['models'][provider]) == sid
                report['providers'][provider].update(session_resume='PASS', resumed_native_pid=resumed_pid)
                t.close()
                t = None
            assert not (root / 'browser-urls.txt').exists(), 'unexpected login attempt'
            report.update(passed=selected_providers == ['codex', 'cursor'], selected_providers_passed=True,
                          authorization='Explicitly authorized app-owned accounts used; OAuth UI itself is NOT tested here')
        except Exception as error:
            report.update(failure_type=type(error).__name__, stage=stage)
        finally:
            if t:
                t.close()
            report['real_model_dispatches'] = sum(e['kind'] == 'real_dispatch' for e in read_events(artifacts / 'events.jsonl'))
            (artifacts / 'report.json').write_text(json.dumps(report, indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--preflight', action='store_true', help='offline binary/help and observer syntax only; never accesses auth')
    parser.add_argument('--allow-subscription-usage', action='store_true')
    parser.add_argument('--auth-directory', type=Path)
    parser.add_argument('--providers', choices=('codex', 'cursor', 'both'), default='both')
    parser.add_argument('--codex-model')
    parser.add_argument('--cursor-model')
    parser.add_argument('--bun', type=Path, default=Path('/usr/sbin/bun'))
    parser.add_argument('--max-requests', type=int, default=40, help='total real model requests across both providers including default helpers, maximum 80')
    parser.add_argument('--artifacts', type=Path, required=True)
    args = parser.parse_args()
    if args.preflight and args.allow_subscription_usage:
        parser.error('Preflight and subscription usage are mutually exclusive')
    if not args.preflight and not (args.allow_subscription_usage and args.auth_directory):
        parser.error('Live run requires parent authorization: --allow-subscription-usage and --auth-directory')
    if not 1 <= args.max_requests <= 80:
        parser.error('Request budget must be between 1 and 80')
    for model in (args.codex_model, args.cursor_model):
        if model is not None and (not re.fullmatch(r'[A-Za-z0-9._:/-]{1,150}', model) or model.startswith(('codex/', 'cursor/'))):
            parser.error('Use exact unqualified wire model IDs, not UI/provider prefixes')
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    if any(artifacts.iterdir()):
        parser.error('Artifact directory must be new and empty')
    report = run(args, artifacts)
    print(('Offline preflight: ' + ('PASS; real gate BLOCKED.' if report.get('offline_preflight') else 'FAIL; inspect redacted report.'))
          if args.preflight else 'Real native Task/Session gate: ' + ('PASS' if report['passed'] else 'NOT PASSED'))
    raise SystemExit(0 if report.get('offline_preflight') or report.get('selected_providers_passed') else 1)


if __name__ == '__main__':
    main()

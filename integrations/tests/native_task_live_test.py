#!/usr/bin/env python3
"""Offline live-runner contracts. Synthetic units, NOT real subscription evidence."""
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from contextlib import redirect_stderr
from unittest.mock import patch

import native_task_live as live


class LiveRunnerTests(unittest.TestCase):
    def test_no_live_execution_without_explicit_consent_and_auth_path(self):
        for argv in ([], ['--allow-subscription-usage'], ['--auth-directory', '/authorized'],
                     ['--preflight', '--allow-subscription-usage'], ['--max-requests', '81']):
            with patch('sys.argv', ['native_task_live.py', '/native', '--artifacts', '/unused', *argv]), \
                 patch.object(live, 'run') as run, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as exit_status:
                    live.main()
                self.assertEqual(exit_status.exception.code, 2)
                run.assert_not_called()

    def test_offline_preflight_and_active_session_guard_never_start_service_or_access_auth(self):
        for preflight in (True, False):
            with self.subTest(preflight=preflight), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                binary = root / 'native'
                binary.write_bytes(b'synthetic-binary-for-unit-only')
                artifacts = root / 'artifacts'
                artifacts.mkdir()
                # Deliberately no auth_directory attribute: accessing credentials
                # before either guard would fail this test.
                args = SimpleNamespace(binary=binary, bun=Path('/usr/sbin/bun'), preflight=preflight)
                with patch.object(live, 'native_preflight'), patch.object(live.subprocess, 'run') as compile_only, \
                     patch.object(live, 'active_native_processes', return_value=[351, 382]) as active, \
                     patch.object(live, 'Terminal') as terminal:
                    report = live.run(args, artifacts)
                terminal.assert_not_called()
                self.assertFalse(report['provider_service_started'])
                self.assertFalse(report['real_accounts'])
                self.assertEqual(report['real_model_dispatches'], 0)
                self.assertEqual(compile_only.call_args.args[0][1], 'build')
                if preflight:
                    active.assert_not_called()
                    self.assertIn('PASS', report['offline_preflight'])
                else:
                    self.assertEqual(report['stage'], 'active_user_session_collision')
                    self.assertEqual(report['blocking_native_pids'], [351, 382])
                    self.assertEqual(report['failure_type'], 'RuntimeError')

    def test_parent_prompts_never_receive_child_only_nonces_or_model_overrides(self):
        with tempfile.TemporaryDirectory() as temp:
            probes = live.make_probes(Path(temp))
            nonces = [p[phase]['nonce'] for p in probes.values() for phase in ('initial', 'resume')]
            self.assertEqual(len(set(nonces)), 4)
            for provider, probe in probes.items():
                for phase in ('initial', 'resume'):
                    prompt = live.task_prompt(probe, phase, 'actual-returned-id' if phase == 'resume' else None)
                    args = json.JSONDecoder().raw_decode(prompt.split('JSON arguments: ', 1)[1])[0]
                    self.assertEqual(set(args), {'prompt', 'description', 'subagent_type', 'background'} | ({'resume_from'} if phase == 'resume' else set()))
                    self.assertIs(args['background'], False)
                    self.assertEqual(args['subagent_type'], 'general-purpose')
                    for nonce in nonces:
                        self.assertNotIn(nonce, prompt)
                    self.assertEqual(Path(probe[phase]['file']).read_text().strip(), probe[phase]['nonce'])
            with self.assertRaises(AssertionError):
                live.task_prompt(probes['codex'], 'resume')

    def test_session_evidence_excludes_child_and_requires_exact_persisted_model(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def session(id, kind=None, model='codex/actual-model'):
                path = root / '.grok/sessions/workspace' / id
                path.mkdir(parents=True)
                (path / 'summary.json').write_text(json.dumps({'session_kind': kind, 'current_model_id': model}))
                (path / 'chat_history.jsonl').write_text('original-private-marker')
            session('parent-session')
            session('child-session', 'subagent')
            self.assertEqual(live.session_evidence(root, 'original-private-marker', 'codex/actual-model'), 'parent-session')
            with self.assertRaisesRegex(AssertionError, 'provider/model changed'):
                live.session_evidence(root, 'original-private-marker', 'cursor/actual-model')
            session('ambiguous-parent')
            with self.assertRaisesRegex(AssertionError, 'expected one'):
                live.session_evidence(root, 'original-private-marker', 'codex/actual-model')

    def test_active_native_process_check_does_not_read_process_arguments_or_auth(self):
        with tempfile.TemporaryDirectory() as temp:
            proc = Path(temp)
            for id, target in (('11', '/native'), ('22', '/different'), ('nonpid', '/native')):
                p = proc / id
                p.mkdir()
                (p / 'exe').symlink_to(target)
            self.assertEqual(live.active_native_processes(Path('/native'), proc), [11])

    def test_observer_retains_default_features_and_has_no_login_or_mock_service(self):
        self.assertIn("nativeArgs:['--fullscreen','--trust']", live.OBSERVER)
        self.assertIn("require(false, 'authorization_owned_by_parent')", live.OBSERVER)
        self.assertIn('cfg.providers.map', live.OBSERVER)
        for flag in ('--always-approve', '--disable-web-search', '--no-memory', '--no-leader', '--no-auto-update'):
            self.assertNotIn(flag, live.OBSERVER)
        self.assertNotIn('MockBridge', live.OBSERVER)
        self.assertNotIn('open_official_browser', live.OBSERVER)

    def test_synthetic_observer_initial_child_resume_and_session_contracts(self):
        # Execute only the pure observer portion; imports of real providers and
        # runNative are removed. No credential store/service or model runs here.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            probes = live.make_probes(root)
            cfg = {'state': str(root / 'state.json'), 'events': str(root / 'events.jsonl'),
                   'maxRequests': 40, 'provider': 'codex', 'models': {'codex': 'actual-model'},
                   'probes': probes, 'resume': None}
            (root / 'cfg.json').write_text(json.dumps(cfg))
            script = live.OBSERVER.split('const factories = ')[0]
            script = '\n'.join(line for line in script.splitlines() if ' = await import(' not in line)
            script += r'''
state.models.codex = 'actual-model';
const credential = {accessToken:'synthetic-private-credential-123456'};
const model = 'actual-model', provider = 'codex', p = cfg.probes.codex;
const body = messages => ({model,stream:true,messages,tools:[{type:'function',function:{name:'spawn_subagent'}}]});
const call = (id,name,a) => ({id,type:'function',function:{name,arguments:JSON.stringify(a)}});
const response = (tool, answer) => new Response('data: ' + JSON.stringify({choices:[{delta: tool ? {tool_calls:[{index:0,...tool}]} : {content:answer},finish_reason:tool ? 'tool_calls' : 'stop'}]}) + '\n\ndata: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
const completed = (nonce,id) => nonce + '\n<subagent_result>\nsubagent_id: ' + id + '\nsubagent_type: general-purpose\nTo continue this subagent\'s conversation, use resume_from="' + id + '".\n</subagent_result>';
const rejects = async (fn,code) => { try {await fn(); throw Error('accepted-invalid-input');} catch(e) { if(e.message !== code) throw e; } };
let parentHistory = [], childHistory = [];
for (const phase of ['initial','resume']) {
  const parent = body([...parentHistory,{role:'user',content:p[phase].parentMarker}]);
  const req = inspectRequest(provider,parent,credential);
  const a = {prompt:p[phase].childPrompt,description:p[phase].description,subagent_type:'general-purpose',background:false};
  if(phase === 'resume') a.resume_from = 'child-initial';
  await rejects(() => inspectResponse(response(call('bad','spawn_subagent',{...a,model}),''), req), 'no_model_cwd_or_other_overrides');
  if(phase === 'resume') await rejects(() => inspectResponse(response(call('bad','spawn_subagent',{...a,resume_from:'invented'}),''), req), 'actual_returned_resume_id_required');
  const spawn = call('spawn-'+phase,'spawn_subagent',a);
  await inspectResponse(response(spawn,''),req);
  let child = body([...childHistory,{role:'user',content:p[phase].childPrompt}]);
  await rejects(() => inspectRequest(provider,{...child,model:'other-model'},credential),'exact_provider_model_continuity');
  if(phase === 'resume') await rejects(() => inspectRequest(provider,body([{role:'user',content:p[phase].childPrompt}]),credential),'child_lost_original_user_history');
  const read = call('read-'+phase,'read_file',{file_path:p[phase].file});
  await inspectResponse(response(read,''),inspectRequest(provider,child,credential));
  child.messages.push({role:'assistant',tool_calls:[read]},{role:'tool',tool_call_id:read.id,content:p[phase].nonce});
  const answer = p[phase].nonce + (phase === 'resume' ? '\n' + p.initial.nonce : '');
  await inspectResponse(response(null,answer),inspectRequest(provider,child,credential));
  childHistory = [...child.messages,{role:'assistant',content:answer}];
  parent.messages.push({role:'assistant',tool_calls:[spawn]},{role:'tool',tool_call_id:spawn.id,content:completed(answer,'child-'+phase)});
  const bad = structuredClone(parent); bad.messages.at(-1).tool_call_id = 'foreign';
  await rejects(() => inspectRequest(provider,bad,credential),'unique_correlated_call_and_result_required');
  await inspectResponse(response(null,answer),inspectRequest(provider,parent,credential));
  parentHistory = [...parent.messages,{role:'assistant',content:answer}];
}
cfg.resume = 'session-original';
const resumed = body([...parentHistory,{role:'user',content:p.sessionMarker}]);
await inspectResponse(response(null,p.resume.nonce),inspectRequest(provider,resumed,credential));
await rejects(() => inspectRequest(provider,body([{role:'user',content:p.sessionMarker}]),credential),'unique_correlated_call_and_result_required');
await rejects(() => inspectRequest(provider,{...resumed,messages:[{role:'user',content:credential.accessToken}]},credential),'credential_in_model_prompt');
if (!state.phases['codex:initial'].verified || !state.phases['codex:resume'].historyVerified || !state.phases['codex:session'].verified) throw Error('missing-verification');
const events = readFileSync(cfg.events,'utf8');
for(const secret of [credential.accessToken,p.initial.nonce,p.resume.nonce]) if(events.includes(secret)) throw Error('published-private-value');
console.log('SYNTHETIC_CONTRACTS_PASS');
'''
            (root / 'unit.mjs').write_text(script)
            result = subprocess.run(['/usr/sbin/bun', str(root / 'unit.mjs'), str(root / 'cfg.json')],
                                    capture_output=True, timeout=20,
                                    env={'PATH': '/usr/bin:/bin', 'POLYCODE_LIVE_USAGE_CONSENT': 'yes'})
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(result.stdout.decode().strip(), 'SYNTHETIC_CONTRACTS_PASS')


if __name__ == '__main__':
    unittest.main(verbosity=2)

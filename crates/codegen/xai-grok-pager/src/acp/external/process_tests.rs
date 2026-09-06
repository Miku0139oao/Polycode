//! Real subprocess transport tests; Python is only a test fixture dependency.
use super::*;
use std::time::Duration;

const MOCK: &str = r#"
import json, sys
assert sys.argv[1:] == ['literal;not-a-shell', '$HOME']
def send(v):
    print(json.dumps(v), flush=True)
def result(id, value):
    send({'jsonrpc':'2.0', 'id':id, 'result':value})
def update(text):
    send({'jsonrpc':'2.0', 'method':'session/update', 'params':{'sessionId':'s1','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text}}}})
models = {'currentModelId':'m1','availableModels':[{'modelId':'m1','name':'First'},{'modelId':'m2','name':'Second'}]}
prompt_id = None
for line in sys.stdin:
    r = json.loads(line)
    m, p = r.get('method'), r.get('params', {})
    assert '_meta' not in p
    if m == 'initialize':
        caps = p.get('clientCapabilities', {})
        assert '_meta' not in caps and not caps.get('terminal')
        assert not caps.get('fs', {}).get('readTextFile') and not caps.get('fs', {}).get('writeTextFile')
        # A stderr flood must not block stdout or be parsed as ACP.
        sys.stderr.write('diagnostic noise\n' * 100000)
        sys.stderr.flush()
        result(r['id'], {'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[{'id':'codex_chatgpt','name':'ChatGPT'}], '_meta':{'grokShell':True,'cancelRewind':True}})
    elif m == 'authenticate':
        assert p['methodId'] == 'codex_chatgpt'
        result(r['id'], {})
    elif m == 'session/new':
        assert p['mcpServers'] == []
        result(r['id'], {'sessionId':'s1','models':models})
    elif m == 'session/load':
        assert p['sessionId'] == 's1' and p['mcpServers'] == []
        result(r['id'], {'models':models})
    elif m == 'session/set_model':
        assert p['modelId'] == 'm2'
        result(r['id'], {})
    elif m == 'session/prompt':
        prompt_id = r['id']
        if p['prompt'][0]['text'] == 'cancel':
            update('waiting for cancellation')
        else:
            send({'jsonrpc':'2.0','id':'permission','method':'session/request_permission','params':{'sessionId':'s1','toolCall':{'toolCallId':'t1','title':'Write a file','kind':'edit','status':'pending'},'options':[{'optionId':'allow','name':'Allow once','kind':'allow_once'},{'optionId':'deny','name':'Reject','kind':'reject_once'}]}})
    elif m == 'session/cancel':
        result(prompt_id, {'stopReason':'cancelled'})
        prompt_id = None
    elif r.get('id') == 'permission':
        outcome = r['result']['outcome']
        assert outcome['outcome'] == 'cancelled' or outcome['optionId'] == 'deny'
        assert '_meta' not in r['result']
        update('permission denied')
        result(prompt_id, {'stopReason':'end_turn'})
        prompt_id = None
    else:
        raise AssertionError(m)
"#;

fn fixture(script: &str) -> ExternalAgentConfig {
    ExternalAgentConfig {
        executable: "/usr/bin/python3".into(),
        args: vec![
            "-u".into(),
            "-c".into(),
            script.into(),
            "literal;not-a-shell".into(),
            "$HOME".into(),
        ],
        auth_method: Some("codex_chatgpt".into()),
    }
}
async fn shutdown(mut c: super::super::AcpConnection) {
    c.cancel.cancel();
    let thread = c.agent_thread.take().unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || thread.join()),
    )
    .await
    .expect("worker must terminate")
    .unwrap()
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn external_process_auth_models_resume_permissions_and_cancel() {
    let mut c = tokio::time::timeout(
        Duration::from_secs(10),
        connect(fixture(MOCK), &CancellationToken::new()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!c.is_grok_shell);
    assert!(!c.cancel_rewind_enabled);
    assert!(c.auth_manager.is_none());
    assert_eq!(
        c.login_method_id.as_ref().unwrap().0.as_ref(),
        "codex_chatgpt"
    );
    acp_send(
        acp::AuthenticateRequest::new(c.login_method_id.clone().unwrap()),
        &c.tx,
    )
    .await
    .unwrap();
    let session = acp_send(
        acp::NewSessionRequest::new(std::env::current_dir().unwrap()),
        &c.tx,
    )
    .await
    .unwrap();
    assert_eq!(session.models.unwrap().available_models.len(), 2);
    let loaded = acp_send(
        acp::LoadSessionRequest::new(session.session_id.clone(), std::env::current_dir().unwrap()),
        &c.tx,
    )
    .await
    .unwrap();
    assert_eq!(loaded.models.unwrap().current_model_id.0.as_ref(), "m1");
    acp_send(
        acp::SetSessionModelRequest::new(session.session_id.clone(), "m2"),
        &c.tx,
    )
    .await
    .unwrap();
    assert!(
        acp_send(
            acp::SetSessionModelRequest::new(session.session_id.clone(), "not-advertised"),
            &c.tx
        )
        .await
        .is_err()
    );
    // Both a user rejection and cancelled permission are relayed without auto-approval.
    for outcome in [
        acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new("deny")),
        acp::RequestPermissionOutcome::Cancelled,
    ] {
        let prompt = acp::PromptRequest::new(
            session.session_id.clone(),
            vec![acp::ContentBlock::Text(acp::TextContent::new("permission"))],
        );
        let (response, ()) = tokio::join!(acp_send(prompt, &c.tx), async {
            match c.rx.recv().await.unwrap() {
                AcpClientMessage::RequestPermission(a) => {
                    a.response_tx
                        .send(Ok(acp::RequestPermissionResponse::new(outcome)))
                        .unwrap();
                }
                _ => panic!("permission was not forwarded"),
            }
            match c.rx.recv().await.unwrap() {
                AcpClientMessage::SessionNotification(a) => {
                    let _ = a.response_tx.send(Ok(()));
                }
                _ => panic!("stream notification was not forwarded"),
            }
        });
        assert_eq!(response.unwrap().stop_reason, acp::StopReason::EndTurn);
    }
    let prompt = acp::PromptRequest::new(
        session.session_id.clone(),
        vec![acp::ContentBlock::Text(acp::TextContent::new("cancel"))],
    );
    let (response, ()) = tokio::join!(acp_send(prompt, &c.tx), async {
        match c.rx.recv().await.unwrap() {
            AcpClientMessage::SessionNotification(a) => {
                let _ = a.response_tx.send(Ok(()));
            }
            _ => panic!("expected stream before cancellation"),
        }
        acp_send(acp::CancelNotification::new(session.session_id), &c.tx)
            .await
            .unwrap();
    });
    assert_eq!(response.unwrap().stop_reason, acp::StopReason::Cancelled);
    shutdown(c).await;
}

#[tokio::test]
async fn external_process_failed_and_malformed_transports_fail_closed() {
    for script in ["import sys; sys.exit(7)", "print('not JSON', flush=True)"] {
        // Include cold interpreter startup under a loaded WSL/CI runner.
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            connect(fixture(script), &CancellationToken::new()),
        )
        .await;
        assert!(
            result
                .expect("dead transport must resolve promptly")
                .is_err()
        );
    }
    let mut config = fixture(MOCK);
    config.executable = "/nonexistent/external-acp".into();
    assert!(
        tokio::time::timeout(
            Duration::from_secs(5),
            connect(config, &CancellationToken::new())
        )
        .await
        .unwrap()
        .is_err()
    );
}

#[tokio::test]
async fn external_process_cancelled_handshake_reaps_child() {
    let tmp = tempfile::tempdir().unwrap();
    let pid_path = tmp.path().join("pid");
    let script = format!(
        "import os,time\nopen({:?}, 'w').write(str(os.getpid()))\ntime.sleep(60)",
        pid_path.to_str().unwrap()
    );
    let cancel = CancellationToken::new();
    let (channel, thread) = spawn(fixture(&script), cancel.clone()).unwrap();
    let pid: i32 = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Some(pid) = std::fs::read_to_string(&pid_path)
                .ok()
                .and_then(|text| text.parse::<i32>().ok())
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || thread.join()),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "child should be reaped");
    drop(channel);
}

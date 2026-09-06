#!/usr/bin/env python3
"""Deterministic ACP process for PTY integration. Never executes tools."""
import json
import os
import sys

def send(message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)

def reply(id, result):
    send({"id": id, "result": result})

def update(kind, **fields):
    send({"method": "session/update", "params": {"sessionId": "mock-session", "update": {"sessionUpdate": kind, **fields}}})

log_path = sys.argv[sys.argv.index('--log') + 1] if '--log' in sys.argv else os.environ.get('GROK_MOCK_LOG')
pending = None
for line in sys.stdin:
    try:
        m = json.loads(line)
    except json.JSONDecodeError:
        continue
    method = m.get("method")
    if log_path:
        with open(log_path, "a") as f:
            f.write(json.dumps({"method": method, "id": m.get("id")}) + "\n")
    id = m.get("id")
    if method == "initialize":
        reply(id, {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}, "agentInfo": {"name": "grok-mock-acp", "version": "1.0"}, "authMethods": []})
    elif method in ("session/new", "session/load"):
        result = {"models": {"currentModelId": "mock", "availableModels": [{"modelId": "mock", "name": "Mock subscription"}]}}
        if method == "session/new":
            result["sessionId"] = "mock-session"
        else:
            update("agent_message_chunk", content={"type": "text", "text": "MOCK_RESUMED"})
        reply(id, result)
    elif method == "session/prompt":
        text = " ".join(b.get("text", "") for b in m["params"]["prompt"])
        if "question" in text:
            pending = id
            send({"id": "mock-question", "method": "_cursor/ask_question", "params": {"sessionId": "mock-session", "toolCallId": "mock-q", "questions": [{"id": "question-exact-id", "prompt": "MOCK_QUESTION_PICK", "options": [{"id": "answer-exact-id", "label": "Mock first answer"}, {"id": "other-id", "label": "Mock second answer"}], "allowMultiple": False}]}})
        elif "plan" in text:
            pending = id
            send({"id": "mock-plan", "method": "_cursor/create_plan", "params": {"sessionId": "mock-session", "toolCallId": "mock-p", "plan": "# MOCK_PLAN_PREVIEW\n\nDisplay only. No tools execute.", "todos": []}})
        elif "permission" in text:
            pending = id
            update("tool_call", toolCallId="mock-tool", title="Mock permission gate", kind="execute", status="pending")
            send({"id": "mock-approval", "method": "session/request_permission", "params": {"sessionId": "mock-session", "toolCall": {"toolCallId": "mock-tool", "title": "Mock permission gate", "status": "pending"}, "options": [{"optionId": "allow", "name": "Allow once", "kind": "allow_once"}, {"optionId": "deny", "name": "Reject", "kind": "reject_once"}]}})
        elif "wait" in text:
            pending = id
            update("agent_message_chunk", content={"type": "text", "text": "MOCK_WAITING"})
        else:
            update("agent_message_chunk", content={"type": "text", "text": "MOCK_STREAM_OK"})
            reply(id, {"stopReason": "end_turn"})
    elif method == "session/cancel":
        if pending is not None:
            reply(pending, {"stopReason": "cancelled"})
            pending = None
    elif method == "session/set_model":
        reply(id, {})
    elif method is None and id in ("mock-question", "mock-plan"):
        outcome = m.get("result", {}).get("outcome", {})
        if id == "mock-question":
            valid = outcome == {"outcome": "answered", "answers": [{"questionId": "question-exact-id", "selectedOptionIds": ["answer-exact-id"]}]}
            marker = "MOCK_QUESTION_EXACT_IDS" if valid else "MOCK_BAD_ANSWER"
        else:
            marker = "MOCK_PLAN_ACCEPTED" if outcome.get("outcome") == "accepted" else "MOCK_PLAN_NOT_ACCEPTED"
        update("agent_message_chunk", content={"type": "text", "text": marker})
        if pending is not None:
            reply(pending, {"stopReason": "end_turn"})
            pending = None
    elif method is None and id == "mock-approval":
        outcome = m.get("result", {}).get("outcome", {})
        allowed = outcome.get("outcome") == "selected" and outcome.get("optionId") == "allow"
        update("tool_call_update", toolCallId="mock-tool", status="completed" if allowed else "failed")
        update("agent_message_chunk", content={"type": "text", "text": "MOCK_ALLOWED" if allowed else "MOCK_DENIED"})
        if pending is not None:
            reply(pending, {"stopReason": "end_turn"})
            pending = None
    elif id is not None and method is not None:
        send({"id": id, "error": {"code": -32601, "message": "Mock has no Grok extensions"}})

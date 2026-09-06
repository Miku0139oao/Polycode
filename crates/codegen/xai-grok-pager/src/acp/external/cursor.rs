//! Narrow Cursor UX adapter. The x.ai request below is client-local, never wire traffic.
use super::*;
use serde::Deserialize;
use serde_json::{Value, json};
use xai_grok_tools::implementations::grok_build::ask_user_question::{
    AskUserQuestionExtRequest, AskUserQuestionExtResponse, AskUserQuestionMode, Question,
    QuestionOption,
};

type BridgeResult<T> = std::result::Result<T, acp::Error>;

#[derive(Clone)]
pub(super) struct Turn {
    id: u64,
    cancel: CancellationToken,
}

#[derive(Default)]
pub(super) struct State {
    next_turn: u64,
    active: HashMap<acp::SessionId, Turn>,
    // Retain old ownership: a late request must not fall back to a different turn.
    // None means conflicting ownership, which must never be guessed.
    tools: HashMap<String, Option<(acp::SessionId, u64)>>,
    todos: HashMap<acp::SessionId, Vec<Todo>>,
}

impl State {
    pub(super) fn begin(&mut self, sid: &acp::SessionId) -> BridgeResult<Turn> {
        if self.active.contains_key(sid) {
            return Err(invalid("External session already has an active prompt"));
        }
        self.next_turn += 1;
        let turn = Turn {
            id: self.next_turn,
            cancel: CancellationToken::new(),
        };
        self.active.insert(sid.clone(), turn.clone());
        Ok(turn)
    }

    pub(super) fn cancel(&mut self, sid: &acp::SessionId) {
        if let Some(turn) = self.active.get(sid) {
            turn.cancel.cancel();
        }
    }

    pub(super) fn finish(&mut self, sid: &acp::SessionId, turn: &Turn) {
        turn.cancel.cancel();
        if self.active.get(sid).is_some_and(|t| t.id == turn.id) {
            self.active.remove(sid);
        }
    }

    pub(super) fn disconnect(&mut self) {
        for turn in self.active.values() {
            turn.cancel.cancel();
        }
        self.active.clear();
    }

    fn bind(&mut self, tool: &str, sid: &acp::SessionId, id: u64) {
        match self.tools.entry(tool.to_owned()) {
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(Some((sid.clone(), id)));
            }
            std::collections::hash_map::Entry::Occupied(mut e) => {
                if e.get().as_ref().is_some_and(|(owner, _)| owner == sid) {
                    e.insert(Some((sid.clone(), id)));
                } else {
                    e.insert(None);
                }
            }
        }
    }

    pub(super) fn observe(&mut self, notification: &acp::SessionNotification) {
        let sid = &notification.session_id;
        let Some(turn) = self.active.get(sid).filter(|t| !t.cancel.is_cancelled()) else {
            return;
        };
        let tool = match &notification.update {
            acp::SessionUpdate::ToolCall(t) => &t.tool_call_id,
            acp::SessionUpdate::ToolCallUpdate(t) => &t.tool_call_id,
            _ => return,
        };
        self.bind(tool.0.as_ref(), sid, turn.id);
    }

    fn route(&mut self, route: &Route) -> BridgeResult<(acp::SessionId, Turn)> {
        if route.tool_call_id.trim().is_empty() {
            return Err(invalid("Missing Cursor toolCallId"));
        }
        let owner = self.tools.get(&route.tool_call_id);
        let sid = if let Some(sid) = &route.session_id {
            let sid = acp::SessionId::new(sid.clone());
            if let Some(owner) = owner {
                let Some((known, id)) = owner else {
                    return Err(invalid("Ambiguous Cursor tool ownership"));
                };
                if known != &sid || !self.active.get(&sid).is_some_and(|t| t.id == *id) {
                    return Err(invalid("Cursor sessionId conflicts with tool ownership"));
                }
            }
            sid
        } else if let Some(owner) = owner {
            let Some((sid, id)) = owner else {
                return Err(invalid("Ambiguous Cursor tool ownership"));
            };
            if !self.active.get(sid).is_some_and(|t| t.id == *id) {
                return Err(invalid("Cursor tool belongs to a finished prompt"));
            }
            sid.clone()
        } else {
            let mut active = self.active.iter().filter(|(_, t)| !t.cancel.is_cancelled());
            let Some((sid, _)) = active.next() else {
                return Err(invalid("No active Cursor session"));
            };
            if active.next().is_some() {
                return Err(invalid("Ambiguous Cursor session"));
            }
            sid.clone()
        };
        let turn = self
            .active
            .get(&sid)
            .filter(|t| !t.cancel.is_cancelled())
            .ok_or_else(|| invalid("Unowned or inactive Cursor session"))?
            .clone();
        self.bind(&route.tool_call_id, &sid, turn.id);
        Ok((sid, turn))
    }

    fn update_todos(&mut self, sid: &acp::SessionId, update: Todos) -> acp::Plan {
        let todos = self.todos.entry(sid.clone()).or_default();
        if !update.merge {
            todos.clear();
        }
        for todo in update.todos {
            if let Some(old) = todos.iter_mut().find(|old| old.id == todo.id) {
                *old = todo;
            } else {
                todos.push(todo);
            }
        }
        acp::Plan::new(
            todos
                .iter()
                .map(|todo| {
                    // ACP has no cancelled status. Keep cancellation visible, never label it completed.
                    let (content, status) = match todo.status {
                        TodoStatus::Pending => {
                            (todo.content.clone(), acp::PlanEntryStatus::Pending)
                        }
                        TodoStatus::InProgress => {
                            (todo.content.clone(), acp::PlanEntryStatus::InProgress)
                        }
                        TodoStatus::Completed => {
                            (todo.content.clone(), acp::PlanEntryStatus::Completed)
                        }
                        TodoStatus::Cancelled => (
                            format!("[cancelled] {}", todo.content),
                            acp::PlanEntryStatus::Pending,
                        ),
                    };
                    acp::PlanEntry::new(content, acp::PlanEntryPriority::Medium, status)
                })
                .collect(),
        )
    }
}

fn invalid(reason: &str) -> acp::Error {
    acp::Error::invalid_params().data(reason)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Route {
    session_id: Option<String>,
    tool_call_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ask {
    #[serde(flatten)]
    route: Route,
    title: Option<String>,
    questions: Vec<CursorQuestion>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorQuestion {
    id: String,
    prompt: String,
    options: Vec<CursorOption>,
    #[serde(default)]
    allow_multiple: bool,
}
#[derive(Deserialize)]
struct CursorOption {
    id: String,
    label: String,
}

#[derive(Clone, Deserialize)]
struct Todo {
    id: String,
    content: String,
    status: TodoStatus,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}
#[derive(Deserialize)]
struct Todos {
    #[serde(flatten)]
    route: Route,
    todos: Vec<Todo>,
    merge: bool,
}
#[derive(Deserialize)]
struct Plan {
    #[serde(flatten)]
    route: Route,
    name: Option<String>,
    overview: Option<String>,
    plan: String,
    todos: Vec<Todo>,
    #[serde(default)]
    phases: Vec<Phase>,
}
#[derive(Deserialize)]
struct Phase {
    name: String,
    todos: Vec<Todo>,
}

fn unique_nonempty<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .all(|v| !v.trim().is_empty() && seen.insert(v))
}

fn question_ui(ask: &Ask, sid: &acp::SessionId) -> BridgeResult<AskUserQuestionExtRequest> {
    if ask.questions.is_empty() || !unique_nonempty(ask.questions.iter().map(|q| q.id.as_str())) {
        return Err(invalid("Cursor questions require unique nonempty IDs"));
    }
    // Native UI keys answers by displayed question/label, not by the optional IDs.
    // Ordinals disambiguate repeated prompts; repeated/reserved labels get ordinals too.
    let duplicate_prompts = !unique_nonempty(ask.questions.iter().map(|q| q.prompt.as_str()));
    let mut questions = Vec::new();
    for (i, q) in ask.questions.iter().enumerate() {
        if q.prompt.trim().is_empty()
            || q.options.is_empty()
            || !unique_nonempty(q.options.iter().map(|o| o.id.as_str()))
            || q.options.iter().any(|o| o.label.trim().is_empty())
        {
            return Err(invalid("Invalid Cursor question/options"));
        }
        let numbered = !unique_nonempty(q.options.iter().map(|o| o.label.as_str()))
            || q.options.iter().any(|o| o.label == "Other");
        questions.push(Question {
            question: if duplicate_prompts {
                format!("{}. {}", i + 1, q.prompt)
            } else {
                q.prompt.clone()
            },
            id: Some(q.id.clone()),
            multi_select: Some(q.allow_multiple),
            options: q
                .options
                .iter()
                .enumerate()
                .map(|(j, o)| QuestionOption {
                    label: if numbered {
                        format!("{}. {}", j + 1, o.label)
                    } else {
                        o.label.clone()
                    },
                    description: ask.title.clone().unwrap_or_default(),
                    preview: None,
                    id: Some(o.id.clone()),
                })
                .collect(),
        });
    }
    Ok(AskUserQuestionExtRequest {
        session_id: sid.to_string(),
        tool_call_id: ask.route.tool_call_id.clone(),
        questions,
        mode: AskUserQuestionMode::Default,
    })
}

fn plan_ui(plan: &Plan, sid: &acp::SessionId) -> BridgeResult<AskUserQuestionExtRequest> {
    if plan.plan.trim().is_empty() {
        return Err(invalid("Cursor plan is empty"));
    }
    let mut preview = String::new();
    if let Some(name) = &plan.name {
        preview.push_str(&format!("# {name}\n\n"));
    }
    if let Some(overview) = &plan.overview {
        preview.push_str(&format!("{overview}\n\n"));
    }
    preview.push_str(&plan.plan); // Full markdown, never a path read or a truncated summary.
    fn append_todos(preview: &mut String, todos: &[Todo]) {
        for todo in todos {
            let status = match todo.status {
                TodoStatus::Pending => "pending",
                TodoStatus::InProgress => "in_progress",
                TodoStatus::Completed => "completed",
                TodoStatus::Cancelled => "cancelled",
            };
            preview.push_str(&format!("\n- [{}] {}: {}", status, todo.id, todo.content));
        }
    }
    append_todos(&mut preview, &plan.todos);
    for phase in &plan.phases {
        preview.push_str(&format!("\n\n## {}", phase.name));
        append_todos(&mut preview, &phase.todos);
    }
    Ok(AskUserQuestionExtRequest {
        session_id: sid.to_string(),
        tool_call_id: plan.route.tool_call_id.clone(),
        mode: AskUserQuestionMode::Default,
        questions: vec![Question {
            question: "Approve this Cursor plan?".into(),
            id: Some("cursor-plan-approval".into()),
            multi_select: Some(false),
            options: [("Accept", "accepted"), ("Reject", "rejected")]
                .into_iter()
                .map(|(label, id)| QuestionOption {
                    label: label.into(),
                    id: Some(id.into()),
                    description: if id == "accepted" {
                        "Explicitly approve this plan."
                    } else {
                        "Do not approve this plan."
                    }
                    .into(),
                    preview: Some(preview.clone()),
                })
                .collect(),
        }],
    })
}

fn outcome(name: &str) -> Value {
    json!({"outcome": {"outcome": name}})
}
fn refused(plan: bool) -> Value {
    json!({"outcome": {"outcome": if plan { "rejected" } else { "skipped" },
        "reason": "No exact option selection: freeform, unknown, duplicate or incomplete answers are not supported"}})
}

fn translate(
    ui: &AskUserQuestionExtRequest,
    response: AskUserQuestionExtResponse,
    plan: bool,
) -> Value {
    let AskUserQuestionExtResponse::Accepted {
        answers,
        annotations,
    } = response
    else {
        return outcome("cancelled");
    };
    if answers.len() != ui.questions.len()
        || annotations.as_ref().is_some_and(|a| {
            a.iter().any(|(key, annotation)| {
                !ui.questions.iter().any(|q| &q.question == key)
                    || annotation.notes.as_ref().is_some_and(|s| !s.is_empty())
            })
        })
    {
        return refused(plan);
    }
    let mut mapped = Vec::new();
    for question in &ui.questions {
        let Some(selected) = answers.get(&question.question) else {
            return refused(plan);
        };
        if selected.is_empty()
            || (!question.multi_select.unwrap_or(false) && selected.len() != 1)
            || !unique_nonempty(selected.iter().map(String::as_str))
        {
            return refused(plan);
        }
        let mut ids = Vec::new();
        for label in selected {
            let Some(id) = question
                .options
                .iter()
                .find(|o| &o.label == label)
                .and_then(|o| o.id.as_ref())
            else {
                return refused(plan);
            };
            ids.push(id.clone());
        }
        if plan {
            return outcome(&ids[0]);
        }
        mapped.push(json!({"questionId": question.id, "selectedOptionIds": ids}));
    }
    json!({"outcome": {"outcome": "answered", "answers": mapped}})
}

fn parse<T: serde::de::DeserializeOwned>(raw: &str) -> BridgeResult<T> {
    serde_json::from_str(raw).map_err(|_| invalid("Malformed Cursor extension parameters"))
}
fn ext_response(value: Value) -> BridgeResult<acp::ExtResponse> {
    Ok(acp::ExtResponse::new(
        serde_json::value::to_raw_value(&value)
            .map_err(|_| acp::Error::internal_error())?
            .into(),
    ))
}

pub(super) async fn request(
    request: acp::ExtRequest,
    tx: &xai_acp_lib::AcpClientTx,
    caps: &Mutex<Capabilities>,
) -> BridgeResult<acp::ExtResponse> {
    // The ACP SDK has already removed the leading wire underscore. Exact allowlist only.
    let (ui, turn, plan) = match request.method.as_ref() {
        "cursor/ask_question" => {
            let ask: Ask = parse(request.params.get())?;
            let (sid, turn) = caps.lock().unwrap().cursor.route(&ask.route)?;
            (question_ui(&ask, &sid)?, turn, false)
        }
        "cursor/create_plan" => {
            let plan: Plan = parse(request.params.get())?;
            let (sid, turn) = caps.lock().unwrap().cursor.route(&plan.route)?;
            (plan_ui(&plan, &sid)?, turn, true)
        }
        _ => return Err(unsupported()),
    };
    let local = acp::ExtRequest::new(
        "x.ai/ask_user_question",
        serde_json::value::to_raw_value(&ui)
            .map_err(|_| acp::Error::internal_error())?
            .into(),
    );
    let response = tokio::select! {
        biased;
        _ = turn.cancel.cancelled() => return ext_response(outcome("cancelled")),
        response = acp_send(local, tx) => response,
    };
    // No await from the final liveness check through reply translation.
    if turn.cancel.is_cancelled() {
        return ext_response(outcome("cancelled"));
    }
    let response = response?;
    ext_response(translate(&ui, parse(response.0.get())?, plan))
}

pub(super) fn notification(
    request: acp::ExtNotification,
    tx: &xai_acp_lib::AcpClientTx,
    caps: &Mutex<Capabilities>,
) -> BridgeResult<()> {
    let (sid, update) = match request.method.as_ref() {
        "cursor/update_todos" => {
            let todos: Todos = parse(request.params.get())?;
            if !unique_nonempty(todos.todos.iter().map(|t| t.id.as_str())) {
                return Err(invalid("Cursor todos require unique nonempty IDs"));
            }
            let mut caps = caps.lock().unwrap();
            let (sid, _) = caps.cursor.route(&todos.route)?;
            let plan = caps.cursor.update_todos(&sid, todos);
            (sid, acp::SessionUpdate::Plan(plan))
        }
        "cursor/task" | "cursor/generate_image" => {
            let route: Route = parse(request.params.get())?;
            let value: Value = parse(request.params.get())?;
            let description = value
                .get("description")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("Missing Cursor description"))?;
            let text = if request.method.as_ref() == "cursor/task" {
                let prompt = value
                    .get("prompt")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("Missing Cursor task prompt"))?;
                let kind = value
                    .get("subagentType")
                    .ok_or_else(|| invalid("Missing Cursor subagentType"))?;
                format!(
                    "\n[Cursor task notification — reported by external agent]\n{description}\nTask prompt: {prompt}\nSubagent type: {kind}\n"
                )
            } else {
                // Paths are displayed as data only; never read files or claim image generation here.
                let path = value
                    .get("filePath")
                    .and_then(Value::as_str)
                    .unwrap_or("not supplied");
                format!(
                    "\n[Cursor image notification — reported by external agent; file not verified]\n{description}\nSuggested path: {path}\n"
                )
            };
            let (sid, _) = caps.lock().unwrap().cursor.route(&route)?;
            (
                sid,
                acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(
                    acp::ContentBlock::Text(acp::TextContent::new(text)),
                )),
            )
        }
        _ => return Err(unsupported()),
    };
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    tx.send(AcpClientMessage::SessionNotification(
        xai_acp_lib::AcpArgs {
            request: acp::SessionNotification::new(sid, update),
            response_tx,
        },
    ))
    .map_err(|_| acp::Error::internal_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask() -> Ask {
        parse(
            r#"{"toolCallId":"tool","questions":[
            {"id":"q:id/1","prompt":"Pick","allowMultiple":true,"options":[
                {"id":"opt:a","label":"A, comma"},{"id":"opt:b","label":"B"}]},
            {"id":"q:id/2","prompt":"Mode","options":[{"id":"single","label":"One"}]}]}"#,
        )
        .unwrap()
    }
    fn accepted(value: Value) -> AskUserQuestionExtResponse {
        serde_json::from_value(value).unwrap()
    }
    fn plan() -> Plan {
        parse(r##"{"toolCallId":"plan-tool","name":"Review","overview":"Overview",
            "plan":"# Full markdown\n\n```rust\nfn main() {}\n```","todos":[],
            "phases":[{"name":"Phase","todos":[{"id":"t","content":"Do it","status":"pending"}]}]}"##).unwrap()
    }
    fn ext(method: &str, value: Value) -> acp::ExtRequest {
        acp::ExtRequest::new(
            method.to_owned(),
            serde_json::value::to_raw_value(&value).unwrap().into(),
        )
    }
    fn route(session: Option<&str>, tool: &str) -> Route {
        Route {
            session_id: session.map(str::to_owned),
            tool_call_id: tool.into(),
        }
    }
    fn active() -> Mutex<Capabilities> {
        let mut caps = Capabilities::default();
        caps.cursor.begin(&"s1".into()).unwrap();
        Mutex::new(caps)
    }

    #[test]
    fn questions_preserve_exact_ids_and_multiselect() {
        let ui = question_ui(&ask(), &"s1".into()).unwrap();
        assert_eq!(ui.mode, AskUserQuestionMode::Default);
        assert_eq!(ui.questions[0].id.as_deref(), Some("q:id/1"));
        assert_eq!(ui.questions[0].multi_select, Some(true));
        assert_eq!(ui.questions[0].options[0].id.as_deref(), Some("opt:a"));
        let result = translate(
            &ui,
            accepted(json!({"outcome":"accepted", "answers":{
            "Pick":["B", "A, comma"], "Mode":["One"]}})),
            false,
        );
        assert_eq!(
            result,
            json!({"outcome":{"outcome":"answered","answers":[
            {"questionId":"q:id/1","selectedOptionIds":["opt:b","opt:a"]},
            {"questionId":"q:id/2","selectedOptionIds":["single"]}]}})
        );
    }

    #[test]
    fn duplicate_display_strings_are_disambiguated_without_changing_ids() {
        let mut ask = ask();
        ask.questions[1].prompt = "Pick".into();
        ask.questions[0].options[1].label = "A, comma".into();
        let ui = question_ui(&ask, &"s1".into()).unwrap();
        let result = translate(
            &ui,
            accepted(json!({"outcome":"accepted","answers":{
            "1. Pick":["2. A, comma"], "2. Pick":["One"]}})),
            false,
        );
        assert_eq!(
            result["outcome"]["answers"][0]["selectedOptionIds"],
            json!(["opt:b"])
        );
        ask.questions[1].id = ask.questions[0].id.clone();
        assert!(question_ui(&ask, &"s1".into()).is_err());
    }

    #[test]
    fn question_unknown_freeform_duplicate_and_incomplete_values_are_not_ids() {
        let ui = question_ui(&ask(), &"s1".into()).unwrap();
        for answers in [
            json!({"Pick":["opt:a"],"Mode":["One"]}),
            json!({"Pick":["Other"],"Mode":["One"]}),
            json!({"Pick":["B","B"],"Mode":["One"]}),
            json!({"Pick":["B"],"Mode":["One","One"]}),
            json!({"Pick":["B"],"unknown":["One"]}),
            json!({"Pick":[]}),
        ] {
            let result = translate(
                &ui,
                accepted(json!({"outcome":"accepted","answers":answers})),
                false,
            );
            assert_eq!(result["outcome"]["outcome"], "skipped");
        }
        let result = translate(
            &ui,
            accepted(json!({"outcome":"accepted","answers":{
            "Pick":["B"],"Mode":["One"]},"annotations":{"Pick":{"notes":"freeform"}}})),
            false,
        );
        assert_eq!(result["outcome"]["outcome"], "skipped");
    }

    #[test]
    fn plan_requires_accept_and_preserves_full_preview() {
        let plan = plan();
        let ui = plan_ui(&plan, &"s1".into()).unwrap();
        for option in &ui.questions[0].options {
            let preview = option.preview.as_ref().unwrap();
            assert!(preview.contains(&plan.plan));
            assert!(preview.contains("Phase"));
            assert!(preview.contains("Do it"));
        }
        for (label, expected) in [
            ("Accept", "accepted"),
            ("Reject", "rejected"),
            ("Other", "rejected"),
            ("accepted", "rejected"),
        ] {
            let result = translate(
                &ui,
                accepted(json!({"outcome":"accepted","answers":{
                "Approve this Cursor plan?":[label]}})),
                true,
            );
            assert_eq!(result["outcome"]["outcome"], expected);
            assert!(result["outcome"].get("planUri").is_none());
        }
        assert_eq!(
            translate(&ui, AskUserQuestionExtResponse::Cancelled, true),
            outcome("cancelled")
        );
        assert_eq!(
            translate(
                &ui,
                accepted(json!({"outcome":"accepted","answers":{}})),
                true
            )["outcome"]["outcome"],
            "rejected"
        );
    }

    #[test]
    fn routes_only_owned_active_sessions_and_rejects_ambiguity() {
        let mut state = State::default();
        assert!(state.route(&route(None, "a")).is_err());
        let s1 = acp::SessionId::new("s1");
        let s2 = acp::SessionId::new("s2");
        let turn = state.begin(&s1).unwrap();
        assert!(state.route(&route(Some("unowned"), "a")).is_err());
        assert_eq!(state.route(&route(None, "a")).unwrap().0, s1);
        state.begin(&s2).unwrap();
        assert!(state.route(&route(None, "unknown")).is_err());
        assert_eq!(state.route(&route(None, "a")).unwrap().0, s1);
        assert!(state.route(&route(Some("s2"), "a")).is_err());
        state.observe(&acp::SessionNotification::new(
            s2.clone(),
            acp::SessionUpdate::ToolCall(acp::ToolCall::new("standard", "Tool")),
        ));
        assert_eq!(state.route(&route(None, "standard")).unwrap().0, s2);
        state.finish(&s1, &turn);
        assert!(turn.cancel.is_cancelled());
        assert!(state.route(&route(None, "a")).is_err()); // No fallback to s2.
        state.begin(&s1).unwrap();
        assert!(state.route(&route(None, "a")).is_err()); // Nor to a newer s1 turn.
        state.observe(&acp::SessionNotification::new(
            s1,
            acp::SessionUpdate::ToolCall(acp::ToolCall::new("standard", "Conflict")),
        ));
        assert!(state.route(&route(None, "standard")).is_err());
    }

    #[test]
    fn todo_merges_replace_by_id_and_isolate_sessions() {
        let mut state = State::default();
        let sid = acp::SessionId::new("s1");
        let update = |todos, merge| {
            serde_json::from_value::<Todos>(json!({"toolCallId":"t","todos":todos,"merge":merge}))
                .unwrap()
        };
        state.update_todos(
            &sid,
            update(
                json!([
            {"id":"1","content":"First","status":"pending"},
            {"id":"2","content":"Second","status":"in_progress"}]),
                false,
            ),
        );
        let plan = state.update_todos(
            &sid,
            update(
                json!([
            {"id":"1","content":"First edited","status":"completed"},
            {"id":"3","content":"Third","status":"cancelled"}]),
                true,
            ),
        );
        assert_eq!(plan.entries.len(), 3);
        assert_eq!(plan.entries[0].content, "First edited");
        assert_eq!(plan.entries[0].status, acp::PlanEntryStatus::Completed);
        assert_eq!(plan.entries[1].status, acp::PlanEntryStatus::InProgress);
        assert_eq!(plan.entries[2].content, "[cancelled] Third");
        assert_ne!(plan.entries[2].status, acp::PlanEntryStatus::Completed);
        assert!(
            state
                .update_todos(&"s2".into(), update(json!([]), true))
                .entries
                .is_empty()
        );
        assert!(
            state
                .update_todos(&sid, update(json!([]), false))
                .entries
                .is_empty()
        );
    }

    #[tokio::test]
    async fn unknown_methods_and_wrong_direction_never_reach_ui() {
        let (mut ui, policy) = acp_channels();
        for method in [
            "cursor/unknown",
            "x.ai/ask_user_question",
            "_cursor/ask_question",
            "cursor/task",
            "cursor/generate_image",
            "cursor/update_todos",
        ] {
            let err = request(ext(method, json!({})), &policy.tx, &active())
                .await
                .unwrap_err();
            assert_eq!(err.code, acp::ErrorCode::MethodNotFound.into());
        }
        for method in [
            "cursor/unknown",
            "cursor/ask_question",
            "cursor/create_plan",
        ] {
            let err = notification(
                acp::ExtNotification::new(
                    method,
                    serde_json::value::to_raw_value(&json!({})).unwrap().into(),
                ),
                &policy.tx,
                &active(),
            )
            .unwrap_err();
            assert_eq!(err.code, acp::ErrorCode::MethodNotFound.into());
        }
        assert!(ui.rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn cancelled_finished_and_disconnected_turns_cannot_answer_pending_bridge() {
        for end in ["cancel", "finish", "disconnect"] {
            let caps = active();
            let (mut ui, policy) = acp_channels();
            let request = ext(
                "cursor/create_plan",
                json!({"toolCallId":"p","plan":"Review me", "todos":[]}),
            );
            let (response, ()) = tokio::join!(request_bridge(request, &policy.tx, &caps), async {
                let AcpClientMessage::ExtMethod(a) = ui.rx.recv().await.unwrap() else {
                    panic!("expected local question")
                };
                assert_eq!(a.request.method.as_ref(), "x.ai/ask_user_question");
                let local: AskUserQuestionExtRequest = parse(a.request.params.get()).unwrap();
                assert_eq!(local.session_id, "s1");
                {
                    let mut caps = caps.lock().unwrap();
                    match end {
                        "cancel" => caps.cursor.cancel(&"s1".into()),
                        "finish" => {
                            let turn = caps.cursor.active[&acp::SessionId::new("s1")].clone();
                            caps.cursor.finish(&"s1".into(), &turn);
                            caps.cursor.begin(&"s1".into()).unwrap();
                        }
                        _ => caps.cursor.disconnect(),
                    }
                }
                // Both futures are ready: cancellation must win over an already queued acceptance.
                a.response_tx
                    .send(ext_response(json!({"outcome":"accepted","answers":{
                    "Approve this Cursor plan?":["Accept"]}})))
                    .unwrap();
            });
            assert_eq!(
                parse::<Value>(response.unwrap().0.get()).unwrap(),
                outcome("cancelled")
            );
        }
    }

    // Alias keeps the test's request local variable readable.
    async fn request_bridge(
        r: acp::ExtRequest,
        tx: &xai_acp_lib::AcpClientTx,
        caps: &Mutex<Capabilities>,
    ) -> BridgeResult<acp::ExtResponse> {
        request(r, tx, caps).await
    }

    #[tokio::test]
    async fn notifications_are_standard_display_only_updates() {
        let caps = active();
        let (mut ui, policy) = acp_channels();
        for (method, value) in [
            (
                "cursor/task",
                json!({"toolCallId":"task","description":"Explore","prompt":"Do not run this","subagentType":{"custom":"test"}}),
            ),
            (
                "cursor/generate_image",
                json!({"toolCallId":"image","description":"An icon","filePath":"/nonexistent/never-read.png","referenceImagePaths":["/etc/shadow"]}),
            ),
            (
                "cursor/update_todos",
                json!({"toolCallId":"todos","merge":false,"todos":[{"id":"1","content":"Todo","status":"pending"}]}),
            ),
        ] {
            notification(
                acp::ExtNotification::new(
                    method,
                    serde_json::value::to_raw_value(&value).unwrap().into(),
                ),
                &policy.tx,
                &caps,
            )
            .unwrap();
            let AcpClientMessage::SessionNotification(a) = ui.rx.recv().await.unwrap() else {
                panic!("expected standard notification")
            };
            assert_eq!(a.request.session_id, acp::SessionId::new("s1"));
            assert!(a.request.meta.is_none());
            if method == "cursor/update_todos" {
                assert!(matches!(a.request.update, acp::SessionUpdate::Plan(_)));
            } else {
                let acp::SessionUpdate::AgentMessageChunk(chunk) = a.request.update else {
                    panic!("expected text")
                };
                let acp::ContentBlock::Text(text) = chunk.content else {
                    panic!("expected text")
                };
                assert!(text.text.contains("reported by external agent"));
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn actual_wire_underscore_is_stripped_and_local_xai_never_leaks() {
        let script = r#"
import json, sys
def send(v): print(json.dumps(v), flush=True)
def result(i, r): send({'jsonrpc':'2.0', 'id':i, 'result':r})
for line in sys.stdin:
    r = json.loads(line)
    assert 'x.ai' not in line and '_meta' not in line
    m = r.get('method')
    if m == 'initialize': result(r['id'], {'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
    elif m == 'session/new': result(r['id'], {'sessionId':'s1'})
    elif m == 'session/prompt':
        prompt_id = r['id']
        send({'jsonrpc':'2.0','id':'q','method':'_cursor/ask_question','params':{'toolCallId':'t','questions':[{'id':'q-id','prompt':'Pick','allowMultiple':True,'options':[{'id':'a-id','label':'A'},{'id':'b-id','label':'B'}]}]}})
    elif r.get('id') == 'q':
        assert r['result'] == {'outcome':{'outcome':'answered','answers':[{'questionId':'q-id','selectedOptionIds':['b-id','a-id']}]}}
        result(prompt_id, {'stopReason':'end_turn'})
    else: raise AssertionError(r)
"#;
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let mut c = connect(
                ExternalAgentConfig {
                    executable: "/usr/bin/python3".into(),
                    args: vec!["-u".into(), "-c".into(), script.into()],
                    auth_method: None,
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            let session = acp_send(
                acp::NewSessionRequest::new(std::env::current_dir().unwrap()),
                &c.tx,
            )
            .await
            .unwrap();
            let (response, ()) = tokio::join!(
                acp_send(
                    acp::PromptRequest::new(
                        session.session_id,
                        vec![acp::ContentBlock::Text(acp::TextContent::new("test"))]
                    ),
                    &c.tx
                ),
                async {
                    let AcpClientMessage::ExtMethod(a) = c.rx.recv().await.unwrap() else {
                        panic!("expected local question")
                    };
                    assert_eq!(a.request.method.as_ref(), "x.ai/ask_user_question");
                    a.response_tx
                        .send(ext_response(
                            json!({"outcome":"accepted","answers":{"Pick":["B","A"]}}),
                        ))
                        .unwrap();
                }
            );
            assert_eq!(response.unwrap().stop_reason, acp::StopReason::EndTurn);
            c.cancel.cancel();
            let thread = c.agent_thread.take().unwrap();
            tokio::task::spawn_blocking(move || thread.join())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        })
        .await
        .unwrap();
    }
}

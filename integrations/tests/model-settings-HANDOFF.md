# Native model settings handoff

Branch: `fix/model-settings`, independent worktree `D:/ai-harness/polycode-fix-model-settings`, base `9dc748d`.
One writer. No agents, Cargo commands, Rust compilation/builds, publish or push. Parent owns the serialized Rust build/test batch. This is NOT a Rust/live acceptance PASS.

## Contracts implemented

### Actual reasoning capabilities

- Codex discovery reads upstream `supported_reasoning_levels` (strings or `{effort, description}`) and `default_reasoning_level`. No model-name heuristic or fabricated high/xhigh menu.
- Bridge model JSON adds optional `reasoningEfforts` (canonical `id/value/label`, optional description, default flag) and `defaultReasoningEffort`. Missing capabilities mean no effort control. An absent upstream default remains absent, rather than selecting the first level.
- Native overlay maps that metadata into existing ACP model/config options. `/provider` offers an effort step; `/model` uses the same real menu, rejects unoffered levels and explicitly reports unsupported control. `/model cancel` cancels pending configuration. Native headless unsupported effort fails instead of dropping it.
- Chat Completions selected effort reaches the existing Codex Responses mapping. The service validates it against the selected provider/model before inference, including conflicting aliases. Cursor remains no-control unless its provider actually supplies implemented capabilities; `cursor/index.mjs` was NOT edited.
- Cross-provider duplicate wire slugs cannot borrow another provider's effort capabilities. Inherited/restored unavailable effort falls back to the target catalog default; explicit API/child-runtime invalid selection fails. Existing native Grok legacy menus remain intact.
- Committed effort persists through `PersistenceMsg::CurrentModel`; the existing captured-child snapshot carries it. New assertions cover child inheritance. Applied null effort is authoritative in the pager and persistence; it cannot revive a stale UI catalog default.

### Queued atomic configuration

- Native ACP model/config requests stage one actor-owned complete `(provider route, model, effort, credentials)` target. The request reply completes after commit; queued/replaced/applied/failure notices are emitted separately. Pager live model, effort, tools, permission state and credential route do not change at admission.
- The slot is replaceable. Each pager choice has a unique selection ID plus local generation/session scope. Cancellation is selection-ID scoped so a late cancel cannot clear a successor. Generic API cancellation is `session/set_model` with `_meta.polycodeCancelPending=true`; an optional `_meta.polycodeSelectionId` scopes it.
- The actor's safe-idle guard includes running/finalizing/queued work, active work guards, parked interactions and active children. Child-coordinator failure is fail-closed. Pending configuration keeps external `IsBusy`/unload queries busy without deadlocking the internal safe-idle check.
- Credential/catalog validation runs in an abort-on-drop local task, not in the command intake loop. Cancel, replacement, authoritative turn error, attach/resume, direct restore and shutdown retire it. Commands win over validation completion. The actor incarnation is checked again before a deferred result updates resident session metadata.
- Effort-only ACP requests are resolved against the pending whole target and reject an intervening target change instead of reverting a newer provider/model selection.
- New chat-state `UpdateSamplingConfigAndCredentials` is a boxed, acknowledged single mailbox mutation. Child snapshot readers cannot see a new route with old credentials. No credential is newly persisted to disk.
- Consent invalidation occurs only after committed provider/model/effort changes, not on queueing, replacement, catalog discovery or a no-op selection. Existing billing-generation and child-route-affinity implementations are unchanged.
- Provider cards refuse to steal an existing tool/plan permission or question. Busy inference alone does not disable the picker. No permission reply/approval is produced by these controls.

### Commit-time catalog/credential validation

- Provider catalog entries add `catalogRevision`, an opaque SHA-256 of credential-store revision and normalized catalog data (no credentials exposed). The pager captures its displayed catalog revision and sends `_meta.polycodeCatalogRevision`; a later refresh cannot silently upgrade an existing pending target to a different account/catalog. API clients may supply the same precondition. Effort-only updates retain the pending target revision.
- New authenticated `POST /control/validate-model` accepts `{provider, model, catalogRevision, effort}`. It obtains a valid credential snapshot, freshly discovers models, compares revision, verifies exact model/effort, and returns `{}`. Changed/removed targets or rotated credentials fail clearly; no alternative model/provider is substituted.
- The shell also fingerprints the target native catalog entry and rechecks the non-serialized allowlist flag at commit. Native credential resolution is rerun with the existing API-key-disable enforcement.
- Token rotation conservatively expires a pending subscription choice even when the account stayed the same; the user must refresh/reselect. This is deliberate fail-closed behavior.
- Once the actor has entered the commit boundary, a later cancel does not undo an already committed model. It only cancels still-pending selection, leaving running work alone.

## UI-agent shared seam supplied

`xai_grok_shell::polycode` now exports:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegisteredModelProvider { NativeGrok, Subscription(ProviderId) }
pub fn registered_model_provider(id: &str) -> Option<RegisteredModelProvider>;
```

This is synchronous, read-only, process-local registration lookup. It performs no network request, credential load or config resolution during rendering. Native identities are positively registered from the trusted pre-user-override original catalog and retained only when the final route/wire identity matches. Subscription identities require authenticated injected registration. Unknown, forged-prefix, rerouted and removed/signed-out entries are not treated as native. Registration is refreshed on model resolution and rebuilt on leader/session restoration. No picker selection participates.

Requested `app/mod.rs` duplicate about text and settings-modal Ask Polycode hints/tests are updated. The UI branch `ed23d99` supplies the usage adapter consuming this API.

## Merge/ownership notes

- Parent OAuth `211debd` was inspected read-only. Its `LOGIN_FAILURE_CODES`, `loginFailure`, login stage tracking and catch changes are disjoint from this patch; preserve them. This branch's `service.mjs` diff touches import, catalog metadata/revisions, validation endpoint, and inference effort validation only. Do not replace the whole file with the base-derived copy.
- Identity `891e8df` files `spawn`, `prompt_build`, `acp_session.rs` and agent prompt/context/templates were not edited.
- Additional necessary integration seams: shell model API/config handler, run loop/commands, new-session effort validation, child explicit-effort validation; pager action/effect/completion routing; chat-state atomic update API. These were announced in the parent transcript because the peer broker was disconnected.

Changed file groups (repository-relative):

- `crates/codegen/xai-grok-shell/src/polycode.rs`, `agent/config.rs`, `agent/handlers/model_switch.rs`, `agent/mvp_agent/{acp_agent,reasoning_effort,session_setup}.rs`, `agent/subagent/handle_request.rs`, `agent/subagent/tests/provider_affinity.rs`.
- Shell `session/{mod,commands,model_settings}.rs`, `session/acp_session_impl/{model_switch,run_loop,model_settings_tests}.rs`.
- `crates/codegen/xai-chat-state/src/{commands,handle}.rs`, `actor/{mod,tests}.rs`.
- Pager `app/{mod,actions,provider,model_settings,external}.rs`, `app/effects/mod.rs`, `app/dispatch/{provider,router,task_result}.rs`, `app/dispatch/session/lifecycle.rs`, `app/dispatch/tests/provider.rs`, `slash/commands/model.rs`, `headless.rs`, `views/settings_modal/{render,tests}.rs`.
- `integrations/native-provider/{codex,service,model-settings}.mjs`, `test/model-settings.test.mjs`, this handoff.

## Actual checks

- `npm ci --ignore-scripts --no-audit --no-fund` in the worktree's native-provider directory installed four locked test dependencies only. No build hooks ran; lockfile unchanged.
- `node --test test/*.test.mjs` in `integrations/native-provider`: **43 tests passed, 0 failed/skipped**. This includes 5 new capability/wire/revision/account-change/removal/inference-validation tests and existing OAuth, store, transport, option and launcher tests. Earlier service test execution failed only because the fresh worktree lacked `proper-lockfile`; it passed after the locked dependency install.
- Standalone rustfmt syntax parsing, edition 2024, `skip_children=true`, on 33 changed Rust files, plus `node --check` on changed JavaScript; no Cargo/compiler was invoked. This proves parsing, NOT types/borrows/runtime behavior. Formatting-only unrelated enum churn was removed.
- `git diff --check` clean at handoff.
- No real provider login/inference, browser/TUI capture or old e8-binary verification was claimed.

## Parent-only Rust batch and live gates

Use the parent's existing toolchain/profile and **default stack**. No increased stack, ignores or weakened assertions:

```text
cargo test -p xai-chat-state --lib model_settings
cargo test -p xai-grok-sampling-types --lib test_chat_completion_request_carries_reasoning_effort_top_level
cargo test -p xai-grok-shell --lib model_settings
cargo test -p xai-grok-shell --lib polycode::
cargo test -p xai-grok-shell --lib registered_subscription_children_preserve_provider_affinity
cargo test -p xai-grok-shell --lib reasoning_effort
cargo test -p xai-grok-shell --lib set_session_model
cargo test -p xai-grok-pager --lib model_settings
cargo test -p xai-grok-pager --lib provider
cargo test -p xai-grok-pager --lib slash::commands::model
cargo test -p xai-grok-pager --lib settings_modal
```

Then the parent's full regression/build batch, including UI handoff tests and existing native-service billing/title/permission tests. Critical new Rust tests cover real actor idle/permission/child guards, atomic chat-state snapshot/restore, persistence, target invalidation, validator retirement, pager replacement/cancel/session scope, exact applied null, capability menus and positive native/subscription registration. They have **not run** here.

With a fresh binary/service, verify actual upstream catalog/default metadata and native controls for the two logged-in subscriptions and Grok; Cursor login still needs the parent's transport fix. During inference, an active tool, and active children, queue/replace/cancel model+effort and inspect unchanged wire route/credential/effort until authoritative idle. Exercise native permission prompts, turn error, new/resume/reconnect, removal/credential rotation during validation and mixed-provider usage. Confirm no native consent invalidation on mere queue and no child route drift. Native model-family compaction and zero-turn harness-rebuild paths require real integration regression coverage.

Remaining gates: successful Rust typecheck/tests/default-stack build, merge validation with parent OAuth/identity/UI, actual TUI/API/native wire capture, real Cursor OAuth, session resume/reconnect race acceptance, and parent release approval. No release PASS or publish authorization is implied.

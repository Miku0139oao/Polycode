# Provider usage UI handoff (fix/provider-ui, base 9dc748d)

## Status and mandatory integration seam

This branch contains usage/render/dispatch and scoped Polycode chrome changes only.
**It is not independently build-ready until the shared identity API below is supplied.**
No Cargo command, Rust build/test, live provider query, old-binary UI validation,
agent launch, publish, or push was performed. Parent retains serialized Rust build
and actual-TUI-capture ownership. Peer inventory was disconnected and a parent
message received no delivery ACK; this document carries the seam request.

The base has `polycode::is_ready_model(id, entry)` and
`is_ready_model_entry(entry)` only as shell-private APIs. The public catalog alone
cannot safely distinguish a native registered model from an unknown/missing one.
Do not replace the identity seam with a URL, model-prefix, or picker-selection test.

The **model-settings owner/parent** must expose this API (or adapt the single
`UsageProvider::for_models` call site to their equivalent authoritative API):

```rust
// xai_grok_shell::polycode (shared owner, NOT edited here)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegisteredModelProvider {
    NativeGrok,
    Subscription(ProviderId),
}
pub fn registered_model_provider(id: &str) -> Option<RegisteredModelProvider>;
```

Required semantics:
- Read-only, synchronous, process-local registration lookup; no network, credential
  loading, config re-resolution, or catalog refresh. Called during rendering.
- Subscription identity comes from the authenticated injected model registry.
- NativeGrok means a registered original native xAI/Grok model, not merely absence
  from the subscription catalog.
- Unknown, missing, forged, or unregistered identity returns None (no billing).
- Preserve registration identity across active session restore/model changes and
  catalog refresh where appropriate; a picker cursor is never the active provider.
- Add shared-owner tests for valid native/ChatGPT/Cursor, forged prefixes/endpoints,
  unknown entries, restored sessions, and a picker selection different from the
  actual current model.

Only the adapter `crates/codegen/xai-grok-pager/src/views/usage_modal/provider.rs`
references this new API. No shared model/settings fields were modified here.
Standalone native mode retains its pre-existing usage behavior when Polycode mode
is not enabled.

## Implemented behavior

- Fullscreen `/usage`, `/context`, `/session-info`: provider/model identity is
  captured from the active session model, with a fresh fetch generation after a
  provider/model change. ChatGPT/Cursor/unknown pages dispatch only local context,
  session-info, and recorded-usage reads, never FetchBilling.
- Subscription quota and remaining balance explicitly say unavailable because no
  supported provider API supplies them. Native xAI tier, credit, PAYG, reset,
  redirect, and billing-error mirrors cannot render as subscription allowance.
- Minimal `/usage` has the same provider attribution and native-billing gate.
- `/usage manage` and its completion/argument routing cannot open native billing
  from a subscription/unknown page. Native billing summaries are labeled as xAI,
  not ChatGPT/Cursor balances. Late native summaries do not appear on subscription
  sessions; native prompt credit warnings are gated by active provider too.
- Session usage always lists reported model IDs, including a single-model session.
  Mixed-provider costs remain on their reported model rows; missing/partial costs
  stay unavailable. Session tokens and reported model API costs are not quota or
  subscription balances. Historical CLI JSON remains a ledger, with unchanged
  wire schema and absent costs, and performs no billing requests.
- Polycode welcome/version badges, workspace trust copy, CLI help, tutorial chrome,
  embedded tutorial prose, docs-picker hint, workflow-empty hint, session-ready
  title, and OSC777 harness title. Native billing/service/vendor/model names,
  licenses, .grok paths, env vars, command compatibility, SDK/crate/protocol IDs
  remain intact. No global Grok replacement.

## Shared-owner follow-ups outside edited scope

- `app/mod.rs` still has the duplicate CLI/about fallback string
  `Polycode — Grok Build TUI with Codex and Cursor backends`; parent should match
  `app/cli.rs`: `Polycode — native workspace for ChatGPT, Cursor and Grok`.
- Settings modal hints still say Ask Grok; model-settings owner should rebrand
  their render/tests together. No edits to those owned files here.
- Native feedback/privacy text and account access errors intentionally retain
  Grok/xAI attribution because those surfaces still describe actual upstream
  services. Other legacy diagnostics wording is outside this focused patch.
- The existing ledger keys model rows by the reported assistant model ID (falling
  back to sampling_config.model), not immutable provider identity. UI deliberately
  does not infer a row's provider from its slug. Parent should verify collisions
  across providers do not merge historical costs undesirably; unambiguous immutable
  provider attribution would require a shell/ledger schema change outside this scope.
- Global background native billing polling/service consent is outside the usage
  page change. Parent's native-service billing validation must verify those
  independent triggers rather than treating the page's effect-list tests as
  proof that the whole process makes zero native requests.

## Tests added/updated (not executed as Rust)

- Actual ratatui Buffer render assertions for both subscriptions at 80x24 and
  120x40 with deliberately contaminated native tier/balance/PAYG/error/redirect
  mirrors; unknown identity display; native allowance/PAYG and all modal copy,
  keyboard, mouse and scrolling tests retained.
- Typed dispatch-boundary tests: all three tabs for ChatGPT/Cursor/unknown emit
  only the three local reads; minimal pages emit neither native request nor
  redirect; provider changes replace the fetch generation and reject old results.
  These isolate the registry decision; shared-owner resolver tests are still needed.
- Subscription command manage refusal; single/mixed model usage cost attribution;
  historical JSON preserves each model's reported/absent costs and no quota.
- Welcome badge and tutorial rendered text assertions, docs-picker width/render
  assertions, OSC777 exact payload assertion.
- Deliberately reviewed **two** existing `session_usage_block_{full,absent_cost}`
  goldens: numeric tokens/time and the $1.2345 or absent-cost value are unchanged;
  the session header explicitly scopes totals to all models, and `Cost` becomes
  `Reported cost`, with explicit non-subscription provenance and missing-model-attribution lines. No ignores, assertion removals, or auto-accept.

Parent-only targeted commands after identity integration (run serially using the
parent's established toolchain/profile/default stack):

```text
cargo test -p xai-grok-pager --lib usage
cargo test -p xai-grok-pager --lib app::dispatch::tests::billing
cargo test -p xai-grok-pager --lib views::welcome
cargo test -p xai-grok-pager --lib views::tutorial
cargo test -p xai-grok-pager --lib tutorial_docs
cargo test -p xai-grok-pager --lib doc_picker
cargo test -p xai-grok-pager --lib workflows_picker_rows
cargo test -p xai-grok-pager --lib notifications::protocol
```

Then the parent's full Rust regression batch, a fresh native binary, and actual
launcher/TUI captures for ChatGPT, Cursor (after parent OAuth repair), and native
Grok. Capture `/usage` before calls, after a reported call, after switching provider,
a mixed-model session, and after resume; check 80x24/resize/scroll and native
permissions/tools are retained. Confirm subscription page opens create no native
billing request and native Grok still shows its real allowance and controls.
The old e8 development binary is not evidence for this changed UI.

## Actual local checks

- `node --test integrations/tests/provider-ui-static.test.mjs`: 4 source-contract
  checks completed, 0 failures. These validate source policy/golden intent only;
  they do **not** execute or validate Rust UI behavior.
- Standalone installed rustfmt 1.94.0, edition 2024, `skip_children=true`, on only
  changed Rust files plus the new adapter: formatting completed without errors.
  This was not Cargo, compilation, or a Rust test.
- `git diff --check`: no whitespace errors.
- Python launcher probes were unavailable (WindowsApps alias / missing registered
  Python311 executable); no Python test execution is claimed.

Remaining gates: shared identity API integration, successful parent Rust tests and
fresh build, actual new-binary TUI captures, real Cursor OAuth, and parent release
acceptance. Nothing in the static checks marks the feature or release PASS.

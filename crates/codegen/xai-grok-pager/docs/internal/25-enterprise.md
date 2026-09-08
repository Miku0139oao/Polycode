# Native feature registry

This public-fork reference restores the operator table required by
`registered_features_are_documented.rs`. Source of truth:
`xai-grok-config-types/src/registry.rs`, `FEATURES`.

Keys below live under `[features]` in native configuration. Requirements/MDM pins,
environment, merged configuration, remote settings and defaults are separate
resolution sources; consult `Feature::resolve` for precedence. These are native
Grok controls, not promises of support by an external ACP agent.

| Feature key | Registry default |
| --- | --- |
| `session_search` | true |
| `lsp_tools` | false |
| `web_fetch` | false |
| `session_recap` | true |
| `ask_user_question` | true |
| `voice_mode` | true |
| `write_file` | true |
| `feedback` | true |
| `feedback_trace_card` | false |
| `turn_summary` | true |
| `cancel_rewind` | true |
| `compaction_verbatim_input` | true |
| `two_pass_compaction` | true |
| `backend_tools` | true |
| `auto_wake` | true |
| `subagent_worktree_snapshot` | false |
| `active_agent_messages` | false |
| `repo_status_in_system_prompt` | true |
| `dock` | false |
| `context_budget` | false |
| `computer_use` | false |

See [environment names](22-environment-variables.md). A default is not an
entitlement: other configuration sources and runtime capabilities can change it.

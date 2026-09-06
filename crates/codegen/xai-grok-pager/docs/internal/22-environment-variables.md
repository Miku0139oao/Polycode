# Registered native feature environment variables

Source of truth: `xai-grok-config-types/src/registry.rs`, `FEATURES`.
This table covers registered boolean features, not every Grok environment variable.
See [native feature registry](25-enterprise.md) for keys and defaults.
External ACP children intentionally do not inherit `GROK_*` variables.

| Environment name | Feature key |
| --- | --- |
| `GROK_SESSION_SEARCH` | session_search |
| `GROK_LSP_TOOLS` | lsp_tools |
| `GROK_WEB_FETCH` | web_fetch |
| `GROK_SESSION_RECAP` | session_recap |
| `GROK_ASK_USER_QUESTION` | ask_user_question |
| `GROK_VOICE_MODE` | voice_mode |
| `GROK_WRITE_FILE` | write_file |
| `GROK_FEEDBACK_ENABLED` | feedback |
| `GROK_FEEDBACK_TRACE_CARD` | feedback_trace_card |
| `GROK_TURN_SUMMARY` | turn_summary |
| `GROK_CANCEL_REWIND` | cancel_rewind |
| `GROK_COMPACTION_VERBATIM_INPUT` | compaction_verbatim_input |
| `GROK_TWO_PASS_COMPACTION` | two_pass_compaction |
| `GROK_BACKEND_SEARCH` | backend_tools |
| `GROK_AUTO_WAKE` | auto_wake |
| `GROK_SUBAGENT_WORKTREE_SNAPSHOT` | subagent_worktree_snapshot |
| `GROK_ACTIVE_AGENT_MESSAGES` | active_agent_messages |
| `GROK_REPO_STATUS_IN_SYSTEM_PROMPT` | repo_status_in_system_prompt |
| `GROK_DOCK` | dock |

`GROK_BACKEND_SEARCH` predates the `backend_tools` key; its spelling is intentional.

#!/usr/bin/env python3
"""Small source-only checks; these do NOT execute Rust, render MiniJinja, or validate wire traffic."""
import hashlib
from pathlib import Path
import re
import unittest

CRATE = Path(__file__).resolve().parent.parent
SHELL = CRATE.parent / "xai-grok-shell"
GUIDANCE = (
    "Polycode is your agent identity, independent of the selected model. "
    "Describe the underlying model and its creator only using authoritative "
    "model/provider metadata; a hosting service is not necessarily the model's creator."
)
# Historical digests were measured with git show 9dc748d:<path> | sha256sum.
TEMPLATES = [
    ("prompt.md", "BASE_PROMPT_ENC", 0x5A,
     "You are Polycode, a provider-neutral software engineering agent.",
     "You are ${{ system_prompt_label }} released by xAI.",
     "40a129c27382f83b5a292eb649ab7d8c56be1b07e952279cac505997a69a626f"),
    ("subagent_prompt.md", "SUBAGENT_PROMPT_ENC", 0x3D,
     "You are a Polycode subagent — a focused worker delegated a specific task.",
     "You are a Grok Build subagent — a focused worker delegated a specific task.",
     "b1b6617c5dcabc0147355045d35ecb54ae4944f48550135e694cfa6590083597"),
    ("apply_patch_prompt.md", "CODEX_PROMPT_ENC", 0x7B,
     "You are Polycode, a terminal-based coding assistant running in the Polycode CLI.",
     "You are a coding agent running in the Grok Build CLI, a terminal-based coding assistant.",
     "1645baba058e100a91f253e8c30b43b3698740d16822f32fb599f2ed5b2780bb"),
]
GOALS = [
    ("goal_planner_prompt.md", "You are the Goal Plan Writer for the Polycode harness.",
     "0c775f693998ea6ccaed351b55fbea5c0ba3ea6badea4dbc06ddba7ca58661d3"),
    ("goal_strategist_prompt.md", "You are the Goal Strategist for the Polycode harness.",
     "5e1cfd0b1bb8dda9cc26ada650062a89a8bb052515c14042e6329fe9956498e1"),
    ("goal_summarizer_prompt.md", "You are the Goal Summarizer for the Polycode harness.",
     "940d62aef8b46cea386c0768f53901354f69d2803849e49276fbe59566851764"),
    ("goal_verifier_prompt.md", "You are an **adversarial verifier** for the Polycode harness.",
     "048cc328137d7cb7e695701fc770435a7c6660f3fdff8f7daa7180d73d6c946a"),
]


class IdentitySources(unittest.TestCase):
    def test_encrypted_templates_exactly_match_source_bytes(self):
        encrypted = (CRATE / "src/prompt/prompt_encrypted.rs").read_text(encoding="utf-8")
        for name, constant, seed, *_ in TEMPLATES:
            with self.subTest(template=name):
                match = re.search(rf"const {constant}: &\[u8\] = &\[([^]]*)\];", encrypted)
                self.assertIsNotNone(match)
                data = bytes(int(value.strip()) for value in match[1].split(","))
                plain = bytes(byte ^ ((seed + index) & 255) for index, byte in enumerate(data))
                self.assertEqual(plain, (CRATE / "templates" / name).read_bytes())

    def test_builtin_identity_is_neutral_at_source_not_appended(self):
        for name, _, _, intro, *_ in TEMPLATES:
            with self.subTest(template=name):
                text = (CRATE / "templates" / name).read_text(encoding="utf-8")
                self.assertTrue(text.startswith(f"{intro} {GUIDANCE}"))
                for stale in ["released by xAI", "Grok Build", "${{ system_prompt_label }}"]:
                    self.assertNotIn(stale, text)
        context = (CRATE / "src/prompt/context.rs").read_text(encoding="utf-8")
        self.assertIn('pub const DEFAULT_SYSTEM_PROMPT_LABEL: &str = "Polycode";', context)
        identity = (CRATE / "src/prompt/identity.rs").read_text(encoding="utf-8")
        self.assertIn(f'const IDENTITY_GUIDANCE: &str = "{GUIDANCE}";', identity)

    def test_legacy_reconstruction_matches_historical_policy_bytes(self):
        for name, _, _, intro, old_intro, digest in TEMPLATES:
            with self.subTest(template=name):
                text = (CRATE / "templates" / name).read_bytes().decode("utf-8")
                prefix = f"{intro} {GUIDANCE}"
                self.assertTrue(text.startswith(prefix))
                historical = (old_intro + text[len(prefix):]).replace(
                    "Documentation about the Polycode TUI", "Documentation about the Grok Build TUI", 1
                )
                self.assertEqual(hashlib.sha256(historical.encode("utf-8")).hexdigest(), digest)

    def test_auxiliary_policy_bytes_only_change_harness_identity(self):
        for name, intro, digest in GOALS:
            with self.subTest(template=name):
                text = (SHELL / "src/session/templates" / name).read_bytes().decode("utf-8")
                self.assertTrue(text.startswith(intro))
                historical = text.replace("for the Polycode harness.", "for the xAI Grok Build harness.", 1)
                self.assertEqual(hashlib.sha256(historical.encode("utf-8")).hexdigest(), digest)

    def test_resume_wiring_loads_old_context_before_saving_and_dispatching(self):
        spawn = (SHELL / "src/session/acp_session_impl/spawn.rs").read_text(encoding="utf-8")
        positions = [spawn.index(fragment) for fragment in [
            "load_prompt_context(&session_info)",
            "migrate_resumed_builtin_identity(&mut conversation, &saved_context, &renderer)",
            "save_prompt_context(&session_info, &prompt_context)",
            "install_system_prompt(",
            "save_system_prompt(&session_info, &sys.content)",
            "persist_chat_history_jsonl_sync(&session_info, &conversation)",
            "chat_state_handle.replace_conversation(conversation)",
        ]]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("if !startup_hints.is_subagent\n        && !startup_hints.preserve_inherited_system", spawn)


if __name__ == "__main__":
    unittest.main(verbosity=2)

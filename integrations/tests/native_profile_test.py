import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from native_pty import native_command, isolated_environment, permission_key

class ProfileTests(unittest.TestCase):
    def test_permission_selects_only_exact_allow_once_label(self):
        screen = "┃  1 (●) Yes, and don't ask again for anything (always-approve mode)\n┃  2 (○) Always allow: (Fixture) Probe\n┃  3 (○) Yes\n┃  4 (○) No, reject (type to add feedback)"
        self.assertEqual(permission_key(screen, 'Yes'), b'3')
        self.assertIsNone(permission_key(screen, 'Unknown'))
        with self.assertRaises(AssertionError):
            permission_key('1 (○) Yes\n2 (○) Yes', 'Yes')

    def test_default_profile_preserves_native_features_and_tool_permissions(self):
        command = native_command('/fixture/native', '/fixture/workspace', True, True)
        self.assertEqual(command, ['/fixture/native', '--polycode-native', '--no-external-acp', '--fullscreen', '--trust', '--cwd', '/fixture/workspace'])

    def test_legacy_baseline_is_explicitly_limited(self):
        command = native_command('/fixture/native', '/fixture/workspace')
        for flag in ['--no-auto-update', '--always-approve', '--disable-web-search', '--no-memory', '--no-leader']:
            self.assertIn(flag, command)

    def test_default_environment_keeps_dashboard_default_without_inheriting_credentials(self):
        for default in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                env = isolated_environment(Path(directory), SimpleNamespace(url='http://127.0.0.1:1', token='synthetic-test-token'), default)
                self.assertEqual('GROK_AGENT_DASHBOARD' not in env, default)
                self.assertNotIn('XAI_API_KEY', env)
                self.assertNotIn('RUST_MIN_STACK', env)
                self.assertEqual(env['POLYCODE_BRIDGE_TOKEN'], 'synthetic-test-token')
                self.assertEqual(env['GROK_TELEMETRY_ENABLED'], 'off')

if __name__ == '__main__':
    unittest.main()

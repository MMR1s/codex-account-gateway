import json
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_agents import agent_snapshot, normalized_path


class LocalAgentsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.db_path = self.home / 'state_5.sqlite'
        self.workspace = self.home / 'project'
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute('CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, model_provider TEXT, archived INTEGER, model TEXT, first_user_message TEXT)')
            db.execute('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT,child_thread_id TEXT,status TEXT)')
            db.executemany('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)', [
                ('parent', 'Main task', str(self.workspace), 300, 'dual-account-local', 0, 'model-a', 'SECRET PROMPT'),
                ('child', 'Child task', str(self.home / 'worktree'), 290, 'dual-account-local', 0, 'model-a', 'SECRET PROMPT'),
                ('grandchild', 'Nested task', str(self.home / 'worktree'), 280, 'openai', 0, 'model-b', 'SECRET PROMPT'),
                ('other', 'Other workspace', str(self.home / 'other'), 200, 'openai', 0, None, 'SECRET PROMPT'),
                ('archived', 'Archived child', str(self.workspace), 100, 'openai', 1, None, 'SECRET PROMPT'),
            ])
            db.executemany('INSERT INTO thread_spawn_edges VALUES(?,?,?)', [
                ('parent', 'child', 'open'), ('child', 'grandchild', 'open'), ('parent', 'archived', 'open')])

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self, scope='workspace'):
        return agent_snapshot(self.workspace, scope, self.home)

    def test_workspace_keeps_real_descendants_in_other_worktrees(self):
        before = self.db_path.read_bytes()
        result = self.snapshot()
        self.assertEqual(result['task_count'], 1)
        self.assertEqual(result['subagent_count'], 2)
        self.assertEqual(result['tasks'][0]['children'][0]['children'][0]['id'], 'grandchild')
        self.assertEqual(self.db_path.read_bytes(), before)

    def test_all_scope_and_privacy_do_not_infer_accounts_or_running(self):
        result = self.snapshot('all')
        self.assertEqual(result['task_count'], 2)
        self.assertFalse(result['live_status_available'])
        self.assertIsNone(result['tasks'][0]['account_slot'])
        self.assertEqual(result['tasks'][0]['status'], 'unknown')
        serialized = json.dumps(result)
        self.assertNotIn('SECRET PROMPT', serialized)
        self.assertNotIn('first_user_message', serialized)
        self.assertNotIn('Archived child', serialized)

    def test_windows_extended_paths_normalize(self):
        self.assertEqual(normalized_path('\\\\?\\C:\\Users\\demo\\project'), normalized_path('C:/Users/demo/project'))

    def test_cycle_is_bounded(self):
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute('INSERT INTO thread_spawn_edges VALUES(?,?,?)', ('grandchild', 'child', 'open'))
        result = self.snapshot()
        self.assertEqual(result['tasks'][0]['children'][0]['children'][0]['children'], [])

    def test_missing_database_is_explicitly_unavailable(self):
        with tempfile.TemporaryDirectory() as empty:
            result = agent_snapshot(self.workspace, codex_home=empty)
            self.assertEqual(result['state'], 'unavailable')
            self.assertEqual(result['tasks'], [])

    def test_unsupported_format_does_not_read_history(self):
        with closing(sqlite3.connect(self.home / 'state_6.sqlite')) as db, db:
            db.execute('CREATE TABLE history (prompt TEXT)')
        result = self.snapshot()
        self.assertEqual(result['state'], 'unavailable')
        self.assertIn('not supported', result['message'])


if __name__ == '__main__':
    unittest.main()

"""Read local Codex task metadata and recorded spawn relationships, never history.

This is a best-effort adapter for a local database, not a live task-control API.
The gateway cannot infer which OAuth account supplied a particular task request.
"""
import os
from contextlib import closing
from pathlib import Path
import sqlite3
import time


def normalized_path(value):
    value = str(value).replace('\\', '/')
    if value.startswith('//?/'):
        value = value[4:]
    return value.rstrip('/').casefold() if os.name == 'nt' else value.rstrip('/')


def agent_snapshot(workspace, scope='workspace', codex_home=None):
    home = Path(codex_home or os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    result = {'state': 'unavailable', 'scope': scope, 'workspace': Path(workspace).name,
              'source': 'Local Codex records', 'live_status_available': False,
              'account_assignment_available': False, 'tasks': [], 'task_count': 0,
              'subagent_count': 0, 'updated_at': time.time()}
    database_home = home
    try:
        import tomllib
        config = tomllib.loads((home / 'config.toml').read_text(encoding='utf-8-sig'))
        if config.get('sqlite_home'):
            database_home = Path(config['sqlite_home']).expanduser()
    except (OSError, ValueError):
        pass
    databases = sorted(database_home.glob('state_*.sqlite'),
                       key=lambda p: int(p.stem.rsplit('_', 1)[-1]) if p.stem.rsplit('_', 1)[-1].isdigit() else -1,
                       reverse=True)
    if not databases:
        result['message'] = 'Local task records are not available on this machine.'
        return result
    try:
        with closing(sqlite3.connect(databases[0].resolve().as_uri() + '?mode=ro', uri=True, timeout=1)) as db:
            db.row_factory = sqlite3.Row
            columns = {r['name'] for r in db.execute('PRAGMA table_info(threads)')}
            required = {'id', 'title', 'cwd', 'updated_at', 'model_provider', 'archived'}
            if not required <= columns:
                result['message'] = 'This Codex database format is not supported.'
                return result
            fields = ['id', 'title', 'cwd', 'updated_at', 'model_provider']
            fields += [c for c in ('model', 'name', 'agent_nickname', 'agent_role', 'agent_path') if c in columns]
            rows = [dict(r) for r in db.execute('SELECT ' + ','.join(fields) +
                    ' FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 2000')]
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            edges = [dict(r) for r in db.execute('SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges')] if 'thread_spawn_edges' in tables else []
    except (OSError, sqlite3.Error):
        result['message'] = 'Local task records are temporarily unavailable.'
        return result
    by_id = {r['id']: r for r in rows}
    parents = {e['child_thread_id']: e['parent_thread_id'] for e in edges}
    children = {}
    for edge in edges:
        children.setdefault(edge['parent_thread_id'], []).append(edge['child_thread_id'])
    workspace_key = normalized_path(workspace)
    matching = lambda r: scope == 'all' or normalized_path(r['cwd']) == workspace_key
    roots = [r for r in rows if matching(r) and (r['id'] not in parents or parents[r['id']] not in by_id)]
    displayed = set()

    def build(row, ancestors):
        identifier = row['id']
        if identifier in ancestors or len(displayed) >= 400:
            return None
        displayed.add(identifier)
        node = {'id': identifier, 'title': str(row.get('name') or row['title'])[:240],
                'kind': 'subagent' if identifier in parents else 'agent',
                'nickname': row.get('agent_nickname'), 'role': row.get('agent_role'),
                'model': row.get('model'), 'provider': row['model_provider'],
                'updated_at': row['updated_at'], 'account_slot': None, 'status': 'unknown',
                'children': []}
        for child_id in children.get(identifier, []):
            child = by_id.get(child_id)
            if child:
                built = build(child, ancestors | {identifier})
                if built:
                    node['children'].append(built)
        return node

    tasks = [build(row, set()) for row in roots[:40]]
    result.update(state='available', tasks=[task for task in tasks if task],
                  task_count=len(roots), subagent_count=sum(identifier in parents for identifier in displayed),
                  displayed_task_count=min(40, len(roots)), truncated=len(roots) > 40 or len(displayed) >= 400,
                  message='Recorded task relationships. Live run state and account attribution are unavailable.')
    return result

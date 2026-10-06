"""Local metadata only: never persist prompts, responses, credentials or identities."""
import json
import sqlite3
import time
from contextlib import contextmanager


class Telemetry:
    def __init__(self, state):
        self.path = state / 'activity.sqlite3'
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, at REAL, slot TEXT, model TEXT, outcome TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER, elapsed_ms INTEGER)')
            db.execute('CREATE TABLE IF NOT EXISTS quota (slot TEXT PRIMARY KEY, data TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS switches (at REAL, slot TEXT)')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def record(self, slot, model, outcome, usage, elapsed):
        usage = usage or {}
        def count(value):
            return value if isinstance(value, int) and value >= 0 else None
        with self.connect() as db:
            db.execute('INSERT INTO activity(at,slot,model,outcome,input_tokens,output_tokens,cached_tokens,reasoning_tokens,elapsed_ms) VALUES(?,?,?,?,?,?,?,?,?)',
                (time.time(), slot, str(model)[:80], outcome, count(usage.get('input_tokens')),
                 count(usage.get('output_tokens')), count((usage.get('input_tokens_details') or {}).get('cached_tokens')),
                 count((usage.get('output_tokens_details') or {}).get('reasoning_tokens')), int(elapsed * 1000)))

    def quota(self, slot, data=None):
        with self.connect() as db:
            if data is not None:
                db.execute('INSERT OR REPLACE INTO quota VALUES(?,?)', (slot, json.dumps(data)))
                return data
            row = db.execute('SELECT data FROM quota WHERE slot=?', (slot,)).fetchone()
            return json.loads(row[0]) if row else {'state': 'waiting'}

    def switched(self, slot):
        with self.connect() as db:
            db.execute('INSERT INTO switches VALUES(?,?)', (time.time(), slot))

    def summary(self):
        with self.connect() as db:
            rows = [dict(r) for r in db.execute('SELECT * FROM activity ORDER BY id DESC LIMIT 50')]
            accounts = {r['slot']: dict(r) for r in db.execute('SELECT slot,COUNT(*) attempts,SUM(outcome="completed") completed,COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,COALESCE(SUM(cached_tokens),0) cached_tokens,COUNT(input_tokens) metered FROM activity GROUP BY slot')}
            switches = db.execute('SELECT COUNT(*) FROM switches').fetchone()[0]
        return {'recent': rows, 'accounts': accounts, 'switches': switches}


def normalize_quota(payload):
    """Whitelist quota fields; backend identity and email must never be stored."""
    rate = payload.get('rate_limit') or {}
    result = {'state': 'available', 'updated_at': time.time(), 'plan': payload.get('plan_type'), 'windows': []}
    for key in ('primary_window', 'secondary_window'):
        window = rate.get(key)
        if not isinstance(window, dict):
            continue
        percent = window.get('used_percent')
        seconds = window.get('limit_window_seconds')
        if not isinstance(percent, (int, float)):
            continue
        result['windows'].append({'label': '5 hours' if seconds == 18000 else 'Weekly' if seconds == 604800 else f'{seconds}s window',
            'used_percent': percent, 'remaining_percent': max(0, 100 - percent),
            'reset_at': window.get('reset_at'), 'duration_seconds': seconds})
    if not result['windows']:
        result['state'] = 'unavailable'
    return result

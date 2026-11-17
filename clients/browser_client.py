"""Small synchronous browser client for local apps and worker agents (stdlib only)."""
import json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import quote
import uuid


class GatewayBrowser:
    def __init__(self, key_file, client_id=None):
        self.key_file = Path(key_file)
        self.client_id = client_id or 'app-' + uuid.uuid4().hex[:16]

    def request(self, method, endpoint, body=None):
        key = self.key_file.read_text(encoding='utf-8').strip()
        request = Request('http://127.0.0.1:4000/v1/browser/' + endpoint,
            method=method, data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        with urlopen(request, timeout=50) as response:
            return json.load(response)

    def state(self):
        return self.request('GET', 'status')

    def launch(self):
        return self.request('POST', 'launch')

    def action(self, action, request_id=None, **parameters):
        return self.request('POST', 'control', {'clientId': self.client_id,
            'requestId': request_id or str(uuid.uuid4()), 'action': {'action': action, **parameters}})

    def result(self, request_id):
        return self.request('GET', 'requests/' + quote(request_id, safe='') + '?clientId=' + quote(self.client_id, safe=''))

    def events(self, after=0):
        return self.request('GET', 'events?after=' + str(max(0, after)))

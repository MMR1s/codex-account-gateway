"""General-purpose local browser integration; credentials never reach dashboard responses."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse


class BrowserWorkspace:
    def __init__(self, here: Path, state: Path):
        self.here = here
        self.state = state

    def connection(self):
        try:
            value = json.loads((self.state / 'browser-session.json').read_text(encoding='utf-8'))
            port, token = value.get('port'), value.get('token')
            if not isinstance(port, int) or not 1024 <= port <= 65535:
                return None
            if not isinstance(token, str) or len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
                return None
            return port, token
        except (OSError, ValueError, TypeError):
            return None

    async def request(self, method: str, path: str, body=None):
        connection = self.connection()
        if not connection:
            return 503, {'error': 'Open the gateway Browser workspace first.'}
        port, token = connection
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=45) as client:
                response = await client.request(method, f'http://127.0.0.1:{port}{path}',
                    headers={'Authorization': 'Bearer ' + token}, json=body)
            return response.status_code, response.json()
        except (httpx.HTTPError, ValueError):
            return 503, {'error': 'Browser workspace is unavailable. Open it from the gateway dashboard.'}

    async def status(self):
        status, value = await self.request('GET', '/state')
        if status != 200:
            return {'running': False, 'message': value.get('error', 'Browser workspace is unavailable.')}
        return value

    async def launch(self):
        current = await self.status()
        if current.get('running'):
            return {'running': True, 'message': 'The browser workspace is already open.'}
        desktop = self.here / 'desktop'
        executable = desktop / 'node_modules' / 'electron' / 'dist' / 'electron.exe'
        if not executable.is_file():
            return {'running': False, 'error': 'Browser runtime is not installed. Run Setup browser.ps1 in the gateway folder.'}
        env = os.environ.copy()
        env.pop('ELECTRON_RUN_AS_NODE', None)
        env['CODEX_GATEWAY_STATE_DIR'] = str(self.state)
        self.state.mkdir(parents=True, exist_ok=True)
        with (self.state / 'browser.log').open('ab') as log:
            subprocess.Popen([str(executable), str(desktop)], cwd=desktop, env=env,
                stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return {'running': False, 'launching': True, 'message': 'Opening the browser workspace on this computer…'}


def install_browser_routes(app, here, state, admin, authorized_gateway):
    workspace = BrowserWorkspace(here, state)

    def authorize(request):
        if request.url.path.startswith('/admin/'):
            admin(request)
        else:
            authorized_gateway(request)

    @app.get('/admin/browser/status')
    @app.get('/v1/browser/status')
    async def browser_status(request: Request):
        authorize(request)
        return await workspace.status()

    @app.post('/admin/browser/launch')
    @app.post('/v1/browser/launch')
    async def browser_launch(request: Request):
        authorize(request)
        result = await workspace.launch()
        return JSONResponse(result, status_code=503 if result.get('error') else 200)

    @app.post('/admin/browser/control')
    @app.post('/v1/browser/control')
    async def browser_control(request: Request):
        authorize(request)
        try:
            raw = await request.body()
            if len(raw) > 60000:
                raise ValueError()
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(400, 'Send a browser action JSON object under 60 KB.')
        status, value = await workspace.request('POST', '/control', body)
        return JSONResponse(value, status_code=status)

    @app.get('/admin/browser/approvals/{approval_id}')
    @app.get('/v1/browser/approvals/{approval_id}')
    async def browser_approval(request: Request, approval_id: str):
        authorize(request)
        if len(approval_id) != 36 or any(c not in '0123456789abcdef-' for c in approval_id):
            raise HTTPException(400, 'Invalid approval ID.')
        status, value = await workspace.request('GET', '/approvals/' + approval_id)
        return JSONResponse(value, status_code=status)

    @app.get('/admin/browser/requests/{request_id}')
    @app.get('/v1/browser/requests/{request_id}')
    async def browser_request(request: Request, request_id: str, clientId: str = 'local-app'):
        from urllib.parse import quote
        authorize(request)
        if len(request_id) > 100 or len(clientId) > 80:
            raise HTTPException(400, 'Invalid browser request identifier.')
        status, value = await workspace.request('GET', '/requests/' + quote(request_id, safe='') + '?clientId=' + quote(clientId, safe=''))
        return JSONResponse(value, status_code=status)

    @app.get('/admin/browser/events')
    @app.get('/v1/browser/events')
    async def browser_events(request: Request, after: int = 0):
        authorize(request)
        status, value = await workspace.request('GET', '/events?after=' + str(max(0, after)))
        return JSONResponse(value, status_code=status)

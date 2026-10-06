"""Loopback Responses gateway with isolated LiteLLM OAuth workers.

Secrets and runtime state live in work/gateway-state, outside the deliverable.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
legacy = ROOT / 'work' / 'gateway-state'
STATE = Path(os.environ.get('CODEX_GATEWAY_STATE_DIR', str(legacy if HERE.name == 'gateway' and legacy.exists() else HERE / '.runtime' / 'state')))
STATE.mkdir(parents=True, exist_ok=True)
PYTHON = Path(sys.executable)
if PYTHON.name.lower() == 'pythonw.exe':
    PYTHON = PYTHON.with_name('python.exe')
PORTS = {'a': 4001, 'b': 4002}
def configured_model():
    import tomllib
    try:
        return tomllib.loads((Path.home() / '.codex' / 'config.toml').read_text(encoding='utf-8-sig')).get('model', 'gpt-5.4')
    except (OSError, ValueError):
        return 'gpt-5.4'
MODEL = os.environ.get('CODEX_GATEWAY_MODEL') or configured_model()
CREATE_HIDDEN = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
from telemetry import Telemetry, normalize_quota


def secret_file(name):
    path = STATE / name
    if not path.exists():
        path.write_text(secrets.token_urlsafe(48), encoding='utf-8')
    return path.read_text(encoding='utf-8').strip()


KEY = secret_file('gateway-key.txt')
INTERNAL_KEY = secret_file('worker-key.txt')


def auth_path(slot):
    return STATE / f'account-{slot}' / 'auth.json'


def account(slot):
    try:
        data = json.loads(auth_path(slot).read_text())
        token = data.get('id_token') or data.get('access_token', '')
        part = token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        return {'connected': bool(data.get('access_token') and data.get('refresh_token')),
                'label': claims.get('email', f'Account {slot.upper()}'),
                'identity': claims.get('sub', ''), 'expires_at': data.get('expires_at')}
    except (OSError, ValueError, IndexError):
        return {'connected': False, 'label': f'Account {slot.upper()}', 'identity': ''}


def auth_environment(slot):
    env = os.environ.copy()
    env['CHATGPT_TOKEN_DIR'] = str(auth_path(slot).parent)
    env['CHATGPT_AUTH_FILE'] = 'auth.json'
    env['PYTHONUNBUFFERED'] = '1'
    env['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
    return env


def login(slot):
    os.environ.update(auth_environment(slot))
    from litellm.llms.chatgpt.authenticator import Authenticator
    from litellm.llms.chatgpt.common_utils import CHATGPT_DEVICE_VERIFY_URL
    try:
        auth = Authenticator()
        code = auth._request_device_code()
        auth._record_device_code_request()
        print(json.dumps({'state': 'waiting', 'url': CHATGPT_DEVICE_VERIFY_URL,
                          'code': code['user_code']}), flush=True)
        authorization = auth._poll_for_authorization_code(code)
        tokens = auth._exchange_code_for_tokens(authorization)
        auth._write_auth_file(auth._build_auth_record(tokens))
        print(json.dumps({'state': 'connected'}), flush=True)
    except Exception as exc:
        # Never emit exception bodies: OAuth errors can contain credential material.
        print(json.dumps({'state': 'error', 'message':
            'Sign-in failed. Enable device code login in ChatGPT Security settings, then retry.',
            'error_type': type(exc).__name__}), flush=True)
        return 1
    return 0


def authorized(request, key):
    supplied = request.headers.get('authorization', '')
    if not hmac.compare_digest(supplied, 'Bearer ' + key):
        raise HTTPException(401, 'Gateway credential required')


def events(text):
    for line in text.splitlines():
        if line.startswith('data: '):
            try:
                yield json.loads(line[6:])
            except ValueError:
                pass


def subscription_request(body, compact=False):
    body = dict(body)
    if isinstance(body.get('input'), str):
        body['input'] = [{'role': 'user', 'content': [
            {'type': 'input_text', 'text': body['input']}]}]
    body.pop('metadata', None)
    for field in ('max_tokens', 'max_output_tokens', 'max_completion_tokens'):
        body.pop(field, None)
    if not compact:
        body['store'] = False
    body.setdefault('instructions', 'You are a coding assistant.')
    return body


def transferable_input(body):
    """Remove opaque reasoning only after an explicit cross-account rejection.

    Ordinary messages, images, tools, and results are kept intact. Opaque compacted
    histories cannot be recovered here, so fail clearly rather than discard them.
    """
    result = dict(body)
    items = body.get('input')
    if not isinstance(items, list):
        return result
    if any(i.get('type') == 'compaction' for i in items if isinstance(i, dict)):
        raise HTTPException(409, 'This chat has account-bound compacted context. '
                            'Continue on its original account or start a new chat with a saved summary.')
    result['input'] = [i for i in items if not isinstance(i, dict) or i.get('type') != 'reasoning']
    return result


def worker_app(slot):
    os.environ.update(auth_environment(slot))
    from litellm.llms.chatgpt.authenticator import Authenticator
    from litellm.llms.chatgpt.common_utils import get_chatgpt_default_headers

    class NoninteractiveAuth(Authenticator):
        def _login_device_code(self):
            raise RuntimeError('Connect this account from the local connection page')

    auth = NoninteractiveAuth()
    auth_lock = asyncio.Lock()
    ledger = Telemetry(STATE)

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=20), trust_env=False) as client:
            app.state.client = client
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.get('/health')
    async def health():
        return {'ok': True, 'slot': slot}

    @app.get('/usage')
    async def usage(request: Request):
        authorized(request, INTERNAL_KEY)
        if not account(slot)['connected']:
            return {'state': 'disconnected'}
        try:
            async with auth_lock:
                access = await asyncio.to_thread(auth.get_access_token)
                aid = await asyncio.to_thread(auth.get_account_id)
            headers = get_chatgpt_default_headers(access, aid)
            headers['Accept'] = 'application/json'
            response = await app.state.client.get('https://chatgpt.com/backend-api/wham/usage', headers=headers, timeout=20)
            if response.status_code != 200:
                return {'state': 'unavailable', 'http_status': response.status_code, 'updated_at': time.time()}
            return normalize_quota(response.json())
        except (httpx.HTTPError, ValueError, RuntimeError):
            return {'state': 'unavailable', 'updated_at': time.time()}

    @app.post('/v1/responses')
    @app.post('/v1/responses/compact')
    async def relay(request: Request):
        authorized(request, INTERNAL_KEY)
        if not account(slot)['connected']:
            raise HTTPException(401, 'Account is not connected')
        try:
            async with auth_lock:
                access = await asyncio.to_thread(auth.get_access_token)
                aid = await asyncio.to_thread(auth.get_account_id)
        except Exception:
            raise HTTPException(401, 'Account needs to be reconnected')
        compact = request.url.path.endswith('/compact')
        body = subscription_request(await request.json(), compact)
        started = time.monotonic()
        session = request.headers.get('session_id') or request.headers.get('x-session-id')
        headers = get_chatgpt_default_headers(access, aid, session)
        headers['Accept'] = 'application/json' if compact else 'text/event-stream'
        path = '/responses/compact' if compact else '/responses'
        try:
            req = app.state.client.build_request('POST', auth.get_api_base().rstrip('/') + path,
                                                json=body, headers=headers)
            upstream = await app.state.client.send(req, stream=True)
        except httpx.HTTPError:
            raise HTTPException(502, 'Could not reach the subscription backend')
        if upstream.status_code >= 400 or compact or not body.get('stream'):
            data = await upstream.aread()
            await upstream.aclose()
            try:
                payload = json.loads(data)
            except ValueError:
                payload = {}
            ledger.record(slot, body.get('model'), 'completed' if upstream.status_code < 400 else f'http_{upstream.status_code}', payload.get('usage'), time.monotonic() - started)
            return Response(data, upstream.status_code,
                headers={k: v for k, v in upstream.headers.items()
                         if k.lower() in ('content-type', 'retry-after')})

        async def chunks():
            pending = b''
            usage_data = None
            outcome = 'interrupted'
            try:
                async for chunk in upstream.aiter_bytes():
                    pending += chunk
                    while b'\n' in pending:
                        line, pending = pending.split(b'\n', 1)
                        for event in events(line.decode('utf-8', errors='replace')):
                            if event.get('type') == 'response.completed':
                                outcome = 'completed'
                                usage_data = (event.get('response') or {}).get('usage')
                            elif event.get('type') in ('error', 'response.failed'):
                                outcome = 'limit' if limit_error(event) else 'failed'
                    if len(pending) > 1048576:
                        pending = b''
                    yield chunk
            finally:
                await upstream.aclose()
                ledger.record(slot, body.get('model'), outcome, usage_data, time.monotonic() - started)
        return StreamingResponse(chunks(), media_type='text/event-stream')

    return app


class RoutingState:
    def __init__(self):
        try:
            self.active = json.loads((STATE / 'routing.json').read_text()).get('active', 'a')
        except (OSError, ValueError):
            self.active = 'a'
        self.cooldown = {'a': 0.0, 'b': 0.0}
        self.last_event = 'Last selected account; updates when a request is routed'

    def candidates(self):
        return [s for s in (self.active, 'b' if self.active == 'a' else 'a')
                if account(s)['connected'] and self.cooldown[s] <= time.time()]

    def limited(self, slot, retry_after=None):
        try:
            delay = max(60, float(retry_after))
        except (TypeError, ValueError):
            delay = 300
        self.cooldown[slot] = time.time() + delay
        self.last_event = f'Account {slot.upper()} reached a limit; trying the other account'

    def selected(self, slot):
        if slot != self.active:
            Telemetry(STATE).switched(slot)
            self.active = slot
            (STATE / 'routing.json').write_text(json.dumps({'active': slot}))
            self.last_event = f'Using account {slot.upper()}'


def limit_error(payload):
    text = json.dumps(payload).lower()
    return any(s in text for s in ('usage_limit_reached', 'rate_limit_exceeded',
                                 'rate_limit_error', 'quota_exceeded', 'insufficient_quota'))


def encrypted_error(payload):
    text = json.dumps(payload).lower()
    return 'encrypted' in text and any(s in text for s in ('invalid', 'decrypt', 'verify'))


def router_app():
    import tomllib
    routing = RoutingState()
    login_state = {s: {'state': 'idle'} for s in PORTS}
    login_tasks = {}
    worker_processes = {}
    ledger = Telemetry(STATE)
    app = FastAPI(docs_url=None, redoc_url=None)
    try:
        config = tomllib.loads((Path.home() / '.codex' / 'config.toml').read_text(encoding='utf-8-sig'))
        if config.get('model_provider') == 'dual-account-local':
            app.state.activation = 'Verified and configured. Restart Codex to use the gateway.'
    except (OSError, ValueError):
        pass

    @app.middleware('http')
    async def local_only(request: Request, call_next):
        if request.headers.get('host') not in ('127.0.0.1:4000', 'localhost:4000', 'testserver'):
            return JSONResponse({'error': 'Local access only'}, 403)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    def admin(request):
        origin = request.headers.get('origin')
        if origin and origin not in ('http://127.0.0.1:4000', 'http://localhost:4000'):
            raise HTTPException(403, 'Use the local connection page')
        if request.headers.get('x-gateway-admin') != '1':
            raise HTTPException(403, 'Use the local connection page')

    def spawn_worker(slot):
        log = open(STATE / f'worker-{slot}.log', 'ab')
        process = subprocess.Popen([str(PYTHON), str(HERE / 'gateway.py'), '--worker', slot],
            env=auth_environment(slot), stdout=log, stderr=log, creationflags=CREATE_HIDDEN)
        log.close()
        worker_processes[slot] = process

    @asynccontextmanager
    async def lifespan(app):
        for slot in PORTS:
            spawn_worker(slot)
        async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10), trust_env=False) as client:
            app.state.client = client
            async def supervise():
                while True:
                    await asyncio.sleep(10)
                    for slot, proc in list(worker_processes.items()):
                        if proc.poll() is not None:
                            spawn_worker(slot)
            task = asyncio.create_task(supervise())
            async def refresh_quotas():
                await asyncio.sleep(5)
                while True:
                    async def refresh(slot):
                        try:
                            response = await client.get(f'http://127.0.0.1:{PORTS[slot]}/usage', headers={'Authorization': 'Bearer ' + INTERNAL_KEY}, timeout=25)
                            if response.status_code == 200:
                                ledger.quota(slot, response.json())
                        except (httpx.HTTPError, ValueError):
                            ledger.quota(slot, {'state': 'unavailable', 'updated_at': time.time()})
                    await asyncio.gather(*(refresh(slot) for slot in PORTS))
                    await asyncio.sleep(60)
            quota_task = asyncio.create_task(refresh_quotas())
            try:
                yield
            finally:
                task.cancel()
                quota_task.cancel()
                for proc in worker_processes.values():
                    proc.terminate()
                for task in login_tasks.values():
                    task.cancel()
    app.router.lifespan_context = lifespan

    @app.get('/')
    async def index():
        return HTMLResponse((HERE / 'index.html').read_text(encoding='utf-8'))

    @app.get('/health')
    async def health():
        return {'ok': True, 'service': 'dual-account-local', 'active': routing.active}

    @app.get('/v1/models')
    async def models(request: Request):
        authorized(request, KEY)
        catalog = STATE / 'model-catalog.json'
        if not catalog.exists():
            raise HTTPException(503, 'Model catalog is not configured')
        data = catalog.read_bytes()
        return Response(data, media_type='application/json',
                        headers={'ETag': hashlib.sha256(data).hexdigest()})

    @app.get('/admin/status')
    async def status(request: Request):
        admin(request)
        rows = {}
        for slot in PORTS:
            info = account(slot)
            info.pop('identity', None)
            rows[slot] = {**info, 'login': login_state[slot],
                'quota': ledger.quota(slot) if info['connected'] else {'state': 'disconnected'},
                'cooldown_seconds': max(0, int(routing.cooldown[slot] - time.time()))}
        return {'accounts': rows, 'active': routing.active, 'last_event': routing.last_event,
                'model': MODEL, 'activation': getattr(app.state, 'activation', 'Not activated'), 'activity': ledger.summary()}

    async def authenticate(slot):
        proc = None
        try:
            login_state[slot] = {'state': 'starting'}
            proc = await asyncio.create_subprocess_exec(str(PYTHON), str(HERE / 'gateway.py'),
                '--login', slot, env=auth_environment(slot), stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, creationflags=CREATE_HIDDEN)
            async for line in proc.stdout:
                try:
                    update = json.loads(line)
                    if update.get('state') in ('waiting', 'connected', 'error'):
                        login_state[slot] = update
                except ValueError:
                    pass
            await proc.wait()
            if proc.returncode and login_state[slot].get('state') != 'error':
                login_state[slot] = {'state': 'error', 'message': 'Sign-in failed; please retry.'}
        finally:
            if proc is not None and proc.returncode is None:
                proc.terminate()

    @app.post('/admin/connect/{slot}')
    async def connect(slot: str, request: Request):
        admin(request)
        if slot not in PORTS:
            raise HTTPException(404)
        if slot in login_tasks and not login_tasks[slot].done():
            return {'ok': True}
        if account(slot)['connected']:
            return {'ok': True, 'message': 'Already connected'}
        login_tasks[slot] = asyncio.create_task(authenticate(slot))
        return {'ok': True}

    @app.post('/admin/activate')
    async def activate(request: Request):
        admin(request)
        accounts = [account(s) for s in PORTS]
        if not all(a['connected'] for a in accounts):
            raise HTTPException(409, 'Connect both accounts first')
        if accounts[0]['identity'] and accounts[0]['identity'] == accounts[1]['identity']:
            raise HTTPException(409, 'Both slots use the same account. Connect two different accounts.')
        app.state.activation = 'Checking both accounts'
        try:
            for slot in PORTS:
                await verify_account(app.state.client, slot)
            configure_codex()
        except Exception as exc:
            app.state.activation = 'Verification failed; Codex provider was not changed'
            raise HTTPException(502, str(exc) if isinstance(exc, RuntimeError)
                                else 'Could not verify the accounts. Please retry.')
        app.state.activation = 'Verified and configured. Restart Codex to use the gateway.'
        return {'ok': True, 'message': app.state.activation}

    @app.post('/admin/disconnect/{slot}')
    async def disconnect(slot: str, request: Request):
        admin(request)
        if slot not in PORTS:
            raise HTTPException(404)
        task = login_tasks.get(slot)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        auth_path(slot).unlink(missing_ok=True)
        ledger.quota(slot, {'state': 'disconnected'})
        login_state[slot] = {'state': 'idle'}
        routing.cooldown[slot] = 0
        return {'ok': True}

    @app.post('/v1/responses')
    @app.post('/v1/responses/compact')
    async def route(request: Request):
        authorized(request, KEY)
        body = await request.json()
        if body.get('previous_response_id'):
            raise HTTPException(409, 'Send full conversation input for account-independent continuation')
        candidates = routing.candidates()
        if not candidates:
            raise HTTPException(503, 'Connect an account, or wait for its allowance to reset')
        compact = request.url.path.endswith('/compact')
        original = dict(body)
        last_response = None
        for slot in candidates:
            for attempt in range(2):
                forwarded = dict(body)
                if not compact:
                    forwarded['stream'] = True
                try:
                    upstream = await app.state.client.send(app.state.client.build_request(
                        'POST', f'http://127.0.0.1:{PORTS[slot]}{request.url.path}', json=forwarded,
                        headers={'Authorization': 'Bearer ' + INTERNAL_KEY,
                                 'session_id': request.headers.get('session_id', '')}), stream=True)
                except httpx.HTTPError:
                    last_response = JSONResponse({'error': {'message': 'Account worker unavailable'}}, 502)
                    break
                if upstream.status_code >= 400 or compact:
                    data = await upstream.aread()
                    await upstream.aclose()
                    try:
                        payload = json.loads(data)
                    except ValueError:
                        payload = {}
                    if upstream.status_code == 429 or limit_error(payload):
                        routing.limited(slot, upstream.headers.get('retry-after'))
                        last_response = Response(data, upstream.status_code,
                            headers={'content-type': upstream.headers.get('content-type', 'application/json')})
                        break
                    if encrypted_error(payload) and attempt == 0:
                        body = transferable_input(original)
                        continue
                    if upstream.status_code >= 400:
                        return Response(data, upstream.status_code,
                            headers={'content-type': upstream.headers.get('content-type', 'application/json')})
                    routing.selected(slot)
                    return Response(data, upstream.status_code, media_type='application/json')

                # Hold the initial events until output begins. A limit error can be
                # represented inside an HTTP 200 stream instead of an HTTP 429.
                iterator = upstream.aiter_lines()
                prefix = []
                failure = None
                async for line in iterator:
                    prefix.append(line + '\n')
                    if line.startswith('data: '):
                        try:
                            event = json.loads(line[6:])
                        except ValueError:
                            continue
                        kind = event.get('type', '')
                        if kind in ('error', 'response.failed'):
                            failure = event
                            break
                        if kind not in ('response.created', 'response.in_progress'):
                            break
                    if sum(map(len, prefix)) > 262144:
                        break
                if failure and (limit_error(failure) or encrypted_error(failure)):
                    await upstream.aclose()
                    if encrypted_error(failure) and attempt == 0:
                        body = transferable_input(original)
                        continue
                    routing.limited(slot)
                    last_response = JSONResponse({'error': {'message': 'Subscription allowance exhausted'}}, 429)
                    break
                routing.selected(slot)

                async def stream(upstream=upstream, iterator=iterator, prefix=prefix):
                    try:
                        for line in prefix:
                            yield line.encode()
                        async for line in iterator:
                            yield (line + '\n').encode()
                    finally:
                        await upstream.aclose()
                return StreamingResponse(stream(), media_type='text/event-stream', headers={'X-Gateway-Account': slot.upper()})
        return last_response or JSONResponse({'error': {'message': 'Accounts unavailable'}}, 503)

    return app


async def verify_account(client, slot):
    response = await client.post(f'http://127.0.0.1:{PORTS[slot]}/v1/responses',
        headers={'Authorization': 'Bearer ' + INTERNAL_KEY}, json={
            'model': MODEL, 'instructions': 'Reply with exactly gateway-ok.',
            'input': 'Confirm the gateway connection.', 'stream': True, 'store': False})
    if response.status_code != 200:
        raise RuntimeError(f'Account {slot.upper()} verification returned HTTP {response.status_code}. '
                           'Check its model access and available allowance.')
    completed = any(e.get('type') == 'response.completed' for e in events(response.text))
    if not completed:
        raise RuntimeError(f'Account {slot.upper()} did not complete a streamed response.')


def configure_codex():
    import tomlkit
    path = Path.home() / '.codex' / 'config.toml'
    text = path.read_text(encoding='utf-8-sig') if path.exists() else ''
    doc = tomlkit.parse(text)
    backup = STATE / 'config-before-gateway.toml'
    if not backup.exists():
        backup.write_text(text, encoding='utf-8')
    doc['model'] = MODEL
    doc['model_provider'] = 'dual-account-local'
    cached = Path.home() / '.codex' / 'models_cache.json'
    catalog = STATE / 'model-catalog.json'
    if cached.exists():
        cached_models = json.loads(cached.read_text(encoding='utf-8')).get('models', [])
        if any(model.get('slug') == MODEL for model in cached_models):
            catalog.write_text(json.dumps({'models': cached_models}), encoding='utf-8')
    if catalog.exists():
        doc['model_catalog_json'] = str(catalog)
    providers = doc.setdefault('model_providers', tomlkit.table())
    provider = tomlkit.table()
    provider.update({'name': 'Local dual-account gateway', 'base_url': 'http://127.0.0.1:4000/v1',
                     'wire_api': 'responses', 'supports_websockets': False})
    auth = tomlkit.table()
    auth.update({'command': str(PYTHON), 'args': [str(HERE / 'gateway.py'), '--print-key'],
                 'timeout_ms': 5000, 'refresh_interval_ms': 300000})
    provider['auth'] = auth
    providers['dual-account-local'] = provider
    path.write_text(tomlkit.dumps(doc), encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', choices=['a', 'b'])
    parser.add_argument('--login', choices=['a', 'b'])
    parser.add_argument('--print-key', action='store_true')
    args = parser.parse_args()
    if args.print_key:
        print(KEY)
    elif args.login:
        sys.exit(login(args.login))
    else:
        # pythonw has no console streams; give Uvicorn a private log destination.
        if sys.stdout is None:
            sys.stdout = open(STATE / 'gateway.log', 'a', encoding='utf-8')
        if sys.stderr is None:
            sys.stderr = sys.stdout
        import uvicorn
        (STATE / ('worker-' + args.worker + '.pid' if args.worker else 'gateway.pid')).write_text(str(os.getpid()))
        uvicorn.run(worker_app(args.worker) if args.worker else router_app(), host='127.0.0.1',
                    port=PORTS[args.worker] if args.worker else 4000, access_log=False, log_level='warning')

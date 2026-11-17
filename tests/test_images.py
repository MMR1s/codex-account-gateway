import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gateway

IMAGE = {'created': 123, 'data': [{'b64_json': 'aW1hZ2U=', 'generation_id': 'test-id'}], 'background': 'opaque'}

def streamed_image():
    return 'data: ' + json.dumps({'type': 'keepalive'}) + '\n\ndata: ' + json.dumps({'type': 'image_generation.completed', 'b64_json': 'aW1hZ2U=', 'created_at': 123, 'generation_id': 'test-id', 'background': 'opaque', 'usage': {'total_tokens': 999}}) + '\n\n'

class ImageTests(unittest.IsolatedAsyncioTestCase):
    def test_stream_conversion_preserves_image_without_mixing_token_units(self):
        self.assertEqual(gateway.image_payload(httpx.Response(200, text=streamed_image(), headers={'content-type': 'text/event-stream'})), IMAGE)
        self.assertEqual(gateway.image_payload(httpx.Response(200, json=IMAGE)), IMAGE)
        for data in ('data: {"type":"keepalive"}\n\n', streamed_image()+'data: {"type":"error"}\n\n'):
            with self.assertRaises(ValueError):
                gateway.image_payload(httpx.Response(200, text=data, headers={'content-type': 'text/event-stream'}))

    async def test_image_routing_auth_both_paths_and_no_credential_leak(self):
        seen = []
        def handler(request):
            seen.append(request)
            return httpx.Response(200, json=IMAGE, headers={'x-codex-imagegen-request-id': 'request-id'})
        with tempfile.TemporaryDirectory() as temp, patch.object(gateway, 'STATE', Path(temp)), patch.object(gateway, 'account', lambda slot: {'connected': True}):
            app = gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client = upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
                    for prefix in ('/v1', '/backend-api/codex'):
                        for operation in ('generations', 'edits'):
                            path = prefix+'/images/'+operation
                            self.assertEqual((await client.post(path, json={})).status_code, 401)
                            result = await client.post(path, json={'model':'gpt-image-2','prompt':'test'}, headers={'X-Gateway-Key':gateway.KEY, 'Authorization':'Bearer native-account-token'})
                            self.assertEqual(result.status_code,200)
                            self.assertEqual(result.json(),IMAGE)
                            self.assertEqual(result.headers['x-codex-imagegen-request-id'],'request-id')
                            self.assertEqual(seen[-1].url.path, '/v1/images/'+operation)
                            self.assertEqual(seen[-1].headers['authorization'],'Bearer '+gateway.INTERNAL_KEY)
                            self.assertNotIn('x-gateway-key',seen[-1].headers)
                    self.assertEqual((await client.post('/v1/images/generations',json={},headers={'Authorization':'Bearer '+gateway.KEY})).status_code,200)
                    self.assertEqual((await client.post('/v1/images/generations',json={},headers={'X-Gateway-Key':'wrong','Authorization':'Bearer native-account-token'})).status_code,401)

    async def test_current_native_token_is_validated_exactly_and_follows_rotation(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(gateway,'STATE',Path(temp)), patch.object(Path,'home',return_value=Path(temp)), patch.dict(gateway.os.environ, {'CODEX_HOME':str(Path(temp)/'.codex')}), patch.object(gateway,'account',lambda slot:{'connected':True}):
            home=Path(temp)/'.codex'; home.mkdir(); auth=home/'auth.json'
            auth.write_text(json.dumps({'tokens':{'access_token':'first-token'}}))
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request:httpx.Response(200,json=IMAGE))) as upstream:
                app.state.client=upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                    async def call(token):
                        return await client.post('/v1/images/generations',json={},headers={'Authorization':'Bearer '+token})
                    self.assertEqual((await call('first-token')).status_code,200)
                    self.assertEqual((await call('made-up-token')).status_code,401)
                    auth.write_text(json.dumps({'tokens':{'access_token':'refreshed-token'}}))
                    self.assertEqual((await call('first-token')).status_code,401)
                    self.assertEqual((await call('refreshed-token')).status_code,200)
                    auth.unlink()
                    self.assertEqual((await call('refreshed-token')).status_code,401)

    async def test_images_never_replay_after_limit_or_connection_failure(self):
        for status in (429, 502):
            calls=[]
            def handler(request):
                calls.append(request.url.port)
                return httpx.Response(status,json={'error':{'message':'failed'}})
            with tempfile.TemporaryDirectory() as temp, patch.object(gateway,'STATE',Path(temp)), patch.object(gateway,'account',lambda slot:{'connected':True}):
                app=gateway.router_app()
                async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                    app.state.client=upstream
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                        r=await client.post('/v1/images/generations',json={},headers={'X-Gateway-Key':gateway.KEY})
                        self.assertEqual(r.status_code,status)
                        self.assertEqual(len(calls),1)

    async def test_native_responses_alias_keeps_existing_text_routing(self):
        seen=[]
        def handler(request):
            seen.append(request)
            return httpx.Response(200,content=b'data: {"type":"response.completed"}\n\n',headers={'content-type':'text/event-stream'})
        with tempfile.TemporaryDirectory() as temp, patch.object(gateway,'STATE',Path(temp)), patch.object(gateway,'account',lambda slot:{'connected':True}):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client=upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                    r=await client.post('/backend-api/codex/responses',json={'input':'test'},headers={'X-Gateway-Key':gateway.KEY,'Authorization':'Bearer native-token'})
                    self.assertEqual(r.status_code,200)
                    self.assertEqual(seen[-1].url.path,'/v1/responses')
                    (Path(temp)/'model-catalog.json').write_text('{"models":[]}')
                    self.assertEqual((await client.get('/backend-api/codex/models',headers={'X-Gateway-Key':gateway.KEY})).json(),{'models':[]})

    async def test_worker_normalizes_subscription_stream_and_uses_only_account_credentials(self):
        from litellm.llms.chatgpt.authenticator import Authenticator
        seen=[]
        def handler(request):
            seen.append(request)
            return httpx.Response(200,text=streamed_image(),headers={'content-type':'text/event-stream','x-codex-imagegen-request-id':'image-request'})
        with tempfile.TemporaryDirectory() as temp, patch.object(gateway,'STATE',Path(temp)), patch.object(gateway,'account',lambda slot:{'connected':True}), patch.object(Authenticator,'get_access_token',return_value='worker-token'), patch.object(Authenticator,'get_account_id',return_value='worker-account'), patch.object(Authenticator,'get_api_base',return_value='https://chatgpt.com/backend-api/codex'):
            app=gateway.worker_app('b')
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client=upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                    result=await client.post('/v1/images/generations',json={'model':'gpt-image-2','prompt':'test'},headers={'Authorization':'Bearer '+gateway.INTERNAL_KEY,'x-gateway-key':'must-not-leak'})
                    self.assertEqual(result.json(),IMAGE)
                    self.assertEqual(seen[0].headers['authorization'],'Bearer worker-token')
                    self.assertEqual(seen[0].headers['accept'],'application/json')
                    self.assertNotIn('x-gateway-key',seen[0].headers)
                    summary=gateway.Telemetry(Path(temp)).summary()
                    self.assertEqual(summary['accounts']['b']['completed'],0)
                    self.assertEqual(summary['recent'][0]['outcome'],'image_completed')
                    self.assertEqual(summary['inflight'],[])

    def test_configuration_separates_coding_auth_from_subscription_images(self):
        import tomlkit
        with tempfile.TemporaryDirectory() as temp, patch.object(gateway,'STATE',Path(temp)), patch.object(Path,'home',return_value=Path(temp)):
            directory=Path(temp)/'.codex'; directory.mkdir(); config=directory/'config.toml'
            config.write_text('model = "test-model"\n')
            gateway.configure_codex()
            result=tomlkit.parse(config.read_text())
            provider=result['model_providers']['dual-account-local']
            self.assertFalse(provider['requires_openai_auth'])
            self.assertIn('--print-key',provider['auth']['args'])
            self.assertEqual(result['mcp_servers']['gateway_images']['tool_timeout_sec'],360)
            self.assertNotIn('http_headers',provider)
            self.assertNotIn(gateway.KEY,config.read_text())
            self.assertTrue(provider['base_url'].endswith('/backend-api/codex'))

if __name__=='__main__': unittest.main()

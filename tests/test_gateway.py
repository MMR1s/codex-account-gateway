import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx

import sys
source = Path(__file__).resolve().parents[1] / 'gateway.py'
sys.path.insert(0, str(source.parent))
spec = importlib.util.spec_from_file_location('gateway', source)
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


def sse(*items):
    return ''.join('data: ' + json.dumps(item) + '\n\n' for item in items).encode()


DONE = sse({'type': 'response.created'}, {'type': 'response.output_text.delta', 'delta': 'ok'},
           {'type': 'response.completed', 'response': {'output': []}})


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    def test_subagent_thread_header_takes_precedence_over_parent_session(self):
        main='01a11296-80b8-74f0-bd83-cf5df814ab6a'
        child='01a1114e-8fc5-7430-b762-6993bc6597cf'
        self.assertEqual(gateway.request_thread_id({'thread-id':child,'session-id':main}),child)
        self.assertEqual(gateway.request_thread_id({'session_id':main}),main)
        self.assertIsNone(gateway.request_thread_id({'thread-id':'arbitrary private content'}))

    async def test_thread_identity_is_forwarded_unchanged_during_failover(self):
        child='01a1114e-8fc5-7430-b762-6993bc6597cf'
        main='01a11296-80b8-74f0-bd83-cf5df814ab6a'
        seen=[]
        def handler(request):
            seen.append((request.headers['thread-id'],request.headers['session_id']))
            return httpx.Response(429,json={'error':{'code':'usage_limit_reached'}}) if request.url.port==4001 else httpx.Response(200,content=DONE,headers={'content-type':'text/event-stream'})
        with tempfile.TemporaryDirectory() as temp, patch.object(gateway,'STATE',Path(temp)), patch.dict(gateway.PORTS,{'a':4001,'b':4002},clear=True), patch.object(gateway,'account',lambda slot:{'connected':True}):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client=upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                    response=await client.post('/v1/responses',json={'input':'test'},headers={'Authorization':'Bearer '+gateway.KEY,'thread-id':child,'session-id':main})
                    self.assertEqual(response.status_code,200)
            self.assertEqual(seen,[(child,main),(child,main)])

    async def run_case(self, handler, body, authorization=True):
        with tempfile.TemporaryDirectory() as temp, patch.object(gateway, 'STATE', Path(temp)), \
             patch.object(gateway, 'account', lambda slot: {'connected': True}):
            app = gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client = upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                             base_url='http://testserver') as client:
                    headers = {'Authorization': 'Bearer ' + gateway.KEY} if authorization else {}
                    return await client.post('/v1/responses', json=body, headers=headers)

    async def test_quota_update_before_limit_does_not_commit_stream(self):
        calls=[]
        def handler(request):
            calls.append(request.url.port)
            if request.url.port==4001:
                return httpx.Response(200,content=sse(
                    {'type':'response.created'},
                    {'type':'codex.rate_limits','rate_limits':{'primary':{'used_percent':100}}},
                    {'type':'error','error':{'code':'usage_limit_reached','message':'Usage limit reached'}}),headers={'content-type':'text/event-stream'})
            return httpx.Response(200,content=DONE,headers={'content-type':'text/event-stream'})
        result=await self.run_case(handler,{'input':'test'})
        self.assertEqual(result.status_code,200)
        self.assertEqual(calls,[4001,4002])
        self.assertNotIn('usage_limit_reached',result.text)
        self.assertNotIn('codex.rate_limits',result.text)
        self.assertEqual(result.headers['x-gateway-account'],'B')

    async def test_http_limit_failover_keeps_tools_and_context(self):
        calls = []
        body = {'model': gateway.MODEL, 'input': [
            {'role': 'user', 'content': 'Keep all this context'},
            {'type': 'function_call', 'call_id': 'call_1', 'name': 'test', 'arguments': '{}'},
            {'type': 'function_call_output', 'call_id': 'call_1', 'output': 'tool result'}],
            'tools': [{'type': 'function', 'name': 'test', 'parameters': {'type': 'object'}}]}

        def handler(request):
            calls.append((request.url.port, json.loads(request.content)))
            if request.url.port == 4001:
                return httpx.Response(429, json={'error': {'code': 'usage_limit_reached'}})
            return httpx.Response(200, content=DONE, headers={'content-type': 'text/event-stream'})

        response = await self.run_case(handler, body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([c[0] for c in calls], [4001, 4002])
        for _, forwarded in calls:
            self.assertEqual(forwarded['input'], body['input'])
            self.assertEqual(forwarded['tools'], body['tools'])
        self.assertIn('response.completed', response.text)

    async def test_limit_inside_http_200_stream_fails_over_without_leaking_prefix(self):
        calls = []
        def handler(request):
            calls.append(request.url.port)
            content = sse({'type': 'response.created', 'response': {'id': 'failed-A'}},
                {'type': 'response.failed', 'response': {'error': {'code': 'usage_limit_reached'}}}) \
                if request.url.port == 4001 else DONE
            return httpx.Response(200, content=content, headers={'content-type': 'text/event-stream'})
        response = await self.run_case(handler, {'model': gateway.MODEL, 'input': 'test'})
        self.assertEqual(calls, [4001, 4002])
        self.assertNotIn('failed-A', response.text)
        self.assertIn('response.completed', response.text)

    async def test_plain_text_usage_limit_fails_over(self):
        calls = []
        def handler(request):
            calls.append(request.url.port)
            if request.url.port == 4001:
                return httpx.Response(400, json={'error': {
                    'message': "You've hit your usage limit. Try again later."}})
            return httpx.Response(200, content=DONE, headers={'content-type': 'text/event-stream'})
        response = await self.run_case(handler, {'input': 'Continue the task'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls, [4001, 4002])
        self.assertNotIn('usage limit', response.text)

    async def test_plain_limit_after_queue_and_empty_reasoning_fails_over(self):
        calls = []
        def handler(request):
            calls.append(request.url.port)
            content = sse(
                {'type': 'response.created', 'response': {'id': 'failed-A'}},
                {'type': 'response.queued'},
                {'type': 'response.output_item.added', 'item': {
                    'type': 'reasoning', 'id': 'reasoning-A', 'summary': []}},
                {'type': 'error', 'message': "You've hit your usage limit. Try again later."}
            ) if request.url.port == 4001 else DONE
            return httpx.Response(200, content=content, headers={'content-type': 'text/event-stream'})
        response = await self.run_case(handler, {'input': 'Continue the task'})
        self.assertEqual(calls, [4001, 4002])
        self.assertNotIn('failed-A', response.text)
        self.assertNotIn('reasoning-A', response.text)
        self.assertIn('response.completed', response.text)

    async def test_next_tool_turn_after_failover_uses_same_gateway_without_restart(self):
        calls = []
        body = {'input': [{'role': 'user', 'content': 'Keep the conversation'}]}
        next_body = {'input': body['input'] + [
            {'type': 'function_call', 'call_id': 'call_1', 'name': 'test', 'arguments': '{}'},
            {'type': 'function_call_output', 'call_id': 'call_1', 'output': 'tool result'}]}
        def handler(request):
            calls.append((request.url.port, json.loads(request.content)))
            if request.url.port == 4001:
                return httpx.Response(200, content=sse({'type': 'response.failed', 'response': {
                    'error': {'message': "You've hit your usage limit. Try again later."}}}),
                    headers={'content-type': 'text/event-stream'})
            return httpx.Response(200, content=DONE, headers={'content-type': 'text/event-stream'})
        with tempfile.TemporaryDirectory() as temp, patch.object(gateway, 'STATE', Path(temp)), \
             patch.dict(gateway.PORTS, {'a': 4001, 'b': 4002}, clear=True), \
             patch.object(gateway, 'account', lambda slot: {'connected': True}):
            app = gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client = upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                             base_url='http://testserver') as client:
                    headers = {'Authorization': 'Bearer ' + gateway.KEY}
                    first = await client.post('/v1/responses', json=body, headers=headers)
                    self.assertIn('response.completed', first.text)
                    second = await client.post('/v1/responses', json=next_body, headers=headers)
                    self.assertIn('response.completed', second.text)
                    self.assertEqual(second.headers['x-gateway-account'], 'B')
            self.assertEqual([port for port, _ in calls], [4001, 4002, 4002])
            self.assertEqual(calls[-1][1]['input'], next_body['input'])

    def test_limit_text_in_normal_output_is_not_an_error(self):
        self.assertFalse(gateway.limit_error({'output': [{'type': 'message',
            'content': "You've hit your usage limit. Try again later."}]}))
        self.assertFalse(gateway.limit_error({'error': {'message': 'Invalid image format'}}))

    async def test_partial_output_is_not_replayed(self):
        calls = []
        def handler(request):
            calls.append(request.url.port)
            return httpx.Response(200, content=sse(
                {'type': 'response.output_text.delta', 'delta': 'started'},
                {'type': 'response.failed', 'response': {'error': {'code': 'usage_limit_reached'}}}),
                headers={'content-type': 'text/event-stream'})
        response = await self.run_case(handler, {'input': 'test'})
        self.assertEqual(calls, [4001])
        self.assertIn('started', response.text)
        self.assertIn('response.failed', response.text)

    async def test_tool_start_is_not_replayed_on_plain_limit(self):
        calls = []
        def handler(request):
            calls.append(request.url.port)
            return httpx.Response(200, content=sse(
                {'type': 'response.output_item.added', 'item': {
                    'type': 'function_call', 'call_id': 'call_1', 'name': 'test', 'arguments': ''}},
                {'type': 'error', 'message': "You've hit your usage limit. Try again later."}),
                headers={'content-type': 'text/event-stream'})
        response = await self.run_case(handler, {'input': 'test'})
        self.assertEqual(calls, [4001])
        self.assertIn('call_1', response.text)
        self.assertIn('usage limit', response.text)

    async def test_unauthenticated_request_cannot_use_accounts(self):
        def handler(request):
            self.fail('Unauthorized request reached an account')
        response = await self.run_case(handler, {'input': 'test'}, authorization=False)
        self.assertEqual(response.status_code, 401)

    async def test_prior_response_id_is_rejected_without_upstream_request(self):
        def handler(request):
            self.fail('Account-bound response ID reached an account')
        response = await self.run_case(handler, {'previous_response_id': 'resp_1', 'input': 'test'})
        self.assertEqual(response.status_code, 409)

    async def test_rejected_reasoning_does_not_remove_visible_context(self):
        calls = []
        body = {'input': [{'type': 'reasoning', 'encrypted_content': 'opaque'},
                          {'role': 'user', 'content': 'Keep this'}]}
        def handler(request):
            forwarded = json.loads(request.content)
            calls.append(forwarded)
            if len(calls) == 1:
                return httpx.Response(400, json={'error': {'code': 'invalid_encrypted_content'}})
            return httpx.Response(200, content=DONE, headers={'content-type': 'text/event-stream'})
        response = await self.run_case(handler, body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls[1]['input'], [{'role': 'user', 'content': 'Keep this'}])

    def test_opaque_compaction_is_never_silently_dropped(self):
        with self.assertRaises(gateway.HTTPException) as caught:
            gateway.transferable_input({'input': [{'type': 'compaction', 'encrypted_content': 'opaque'}]})
        self.assertEqual(caught.exception.status_code, 409)

    def test_separate_token_directories(self):
        a, b = gateway.auth_environment('a'), gateway.auth_environment('b')
        self.assertNotEqual(a['CHATGPT_TOKEN_DIR'], b['CHATGPT_TOKEN_DIR'])
        self.assertEqual(a.get('CODEX_HOME'), b.get('CODEX_HOME'))

    def test_subscription_backend_receives_list_input(self):
        original = {'input': 'Check connection', 'stream': True, 'max_output_tokens': 20}
        result = gateway.subscription_request(original)
        self.assertEqual(result['input'], [{'role': 'user', 'content': [
            {'type': 'input_text', 'text': 'Check connection'}]}])
        self.assertEqual(original['input'], 'Check connection')
        self.assertFalse(result['store'])
        self.assertNotIn('max_output_tokens', result)

    def test_activation_preserves_existing_configuration_and_backs_it_up(self):
        import tomlkit
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / 'home'
            state = Path(temp) / 'state'
            state.mkdir()
            config = home / '.codex' / 'config.toml'
            config.parent.mkdir(parents=True)
            original = '# Keep this comment\nmodel = "gpt-6.1-sol"\n[features]\njs_repl = true\n'
            config.write_text(original)
            with patch.object(gateway, 'STATE', state), patch.object(Path, 'home', return_value=home):
                gateway.configure_codex()
            data = tomlkit.parse(config.read_text())
            self.assertEqual(data['model_provider'], 'dual-account-local')
            self.assertTrue(data['features']['js_repl'])
            self.assertIn('# Keep this comment', config.read_text())
            self.assertEqual((state / 'config-before-gateway.toml').read_text(), original)
            provider = data['model_providers']['dual-account-local']
            self.assertEqual(provider['wire_api'], 'responses')
            self.assertFalse(provider['supports_websockets'])
            self.assertFalse(provider['requires_openai_auth'])
            self.assertIn('--print-key', provider['auth']['args'])
            self.assertIn('gateway_images', data['mcp_servers'])
            self.assertNotIn(gateway.KEY, config.read_text())


if __name__ == '__main__':
    unittest.main()

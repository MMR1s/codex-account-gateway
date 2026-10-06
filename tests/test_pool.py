import sys
import asyncio
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import gateway
import httpx
import tempfile
import json
import unittest
from unittest.mock import patch

class PoolTests(unittest.IsolatedAsyncioTestCase):
    async def test_failover_reaches_third_account(self):
        calls=[]
        def handler(request):
            calls.append(request.url.port)
            if request.url.port != 4003:
                return httpx.Response(429,json={'error':{'code':'usage_limit_reached'}})
            return httpx.Response(200,content=b'data: {"type":"response.completed"}\n\n',headers={'content-type':'text/event-stream'})
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)),patch.dict(gateway.PORTS,{'a':4001,'b':4002,'c':4003},clear=True),patch.object(gateway,'account',lambda s:{'connected':True}):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client=upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as c:
                    response=await c.post('/v1/responses',headers={'Authorization':'Bearer '+gateway.KEY},json={'input':'test'})
            self.assertEqual(calls,[4001,4002,4003])
            self.assertEqual(response.headers['x-gateway-account'],'C')
    async def test_add_remove_and_persist_slot(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)),patch.dict(gateway.PORTS,{'a':4001,'b':4002},clear=True),patch.object(gateway,'account',lambda s:{'connected':False}),patch.object(gateway.subprocess,'Popen') as process,patch.object(gateway,'port_available',return_value=True):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'X-Gateway-Admin':'1'}) as c:
                r=await c.post('/admin/accounts')
                self.assertEqual(r.status_code,200)
                self.assertEqual(r.json()['slot'],'c')
                self.assertEqual(gateway.load_slots()['c'],4003)
                command=process.call_args.args[0]
                self.assertEqual(command[-2:],['--worker','c'])
                r=await c.delete('/admin/accounts/c')
                self.assertEqual(r.status_code,200)
                self.assertNotIn('c',gateway.load_slots())
                self.assertEqual((await c.delete('/admin/accounts/a')).status_code,409)
    async def test_admin_origin_is_enforced(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as c:
                r=await c.post('/admin/accounts',headers={'X-Gateway-Admin':'1','Origin':'https://other.test'})
                self.assertEqual(r.status_code,403)

    async def test_dashboard_routes_and_static_whitelist(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as c:
                for path in ('/overview','/accounts','/agents','/activity','/settings'):
                    r=await c.get(path)
                    self.assertEqual(r.status_code,200)
                    self.assertIn('/assets/app.js',r.text)
                self.assertTrue((await c.get('/assets/app.js')).headers['content-type'].startswith('application/javascript'))
                self.assertEqual((await c.get('/assets/gateway.py')).status_code,404)
                self.assertEqual((await c.get('/assets/local_agents.py')).status_code,404)

    async def test_agent_records_require_admin_header_and_validate_scope(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)),patch.object(gateway,'agent_snapshot',return_value={'state':'available','tasks':[]}) as read:
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as c:
                self.assertEqual((await c.get('/admin/agents')).status_code,403)
                self.assertEqual((await c.get('/admin/agents',headers={'X-Gateway-Admin':'1','Origin':'https://other.test'})).status_code,403)
                self.assertEqual((await c.get('/admin/agents?scope=invalid',headers={'X-Gateway-Admin':'1'})).status_code,400)
                read.assert_not_called()
                self.assertEqual((await c.get('/admin/agents?scope=all',headers={'X-Gateway-Admin':'1'})).status_code,200)
                self.assertEqual(read.call_args.args[1],'all')

    async def test_manual_selection_routes_next_request_and_persists(self):
        calls=[]
        def handler(request):
            calls.append(request.url.port)
            return httpx.Response(200,content=b'data: {"type":"response.completed"}\n\n',headers={'content-type':'text/event-stream'})
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)),patch.dict(gateway.PORTS,{'a':4001,'b':4002},clear=True),patch.object(gateway,'account',lambda slot:{'connected':True}):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client=upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                    self.assertEqual((await client.post('/admin/select/b')).status_code,403)
                    self.assertEqual((await client.post('/admin/select/b',headers={'X-Gateway-Admin':'1','Origin':'https://other.test'})).status_code,403)
                    self.assertEqual((await client.post('/admin/select/z',headers={'X-Gateway-Admin':'1'})).status_code,404)
                    selected=await client.post('/admin/select/b',headers={'X-Gateway-Admin':'1'})
                    self.assertEqual(selected.status_code,200)
                    self.assertEqual(selected.json()['active'],'b')
                    self.assertEqual(gateway.RoutingState().active,'b')
                    self.assertEqual(json.loads((Path(temp)/'routing.json').read_text())['active'],'b')
                    response=await client.post('/v1/responses',headers={'Authorization':'Bearer '+gateway.KEY},json={'input':'test'})
                    self.assertEqual(response.headers['x-gateway-account'],'B')
                    status=(await client.get('/admin/status',headers={'X-Gateway-Admin':'1'})).json()
                    self.assertEqual(status['activity']['switches'],1)
                    await client.post('/admin/select/b',headers={'X-Gateway-Admin':'1'})
                    self.assertEqual((await client.get('/admin/status',headers={'X-Gateway-Admin':'1'})).json()['activity']['switches'],1)
            self.assertEqual(calls,[4002])

    async def test_manual_selection_rejects_disconnected_and_cooling_accounts(self):
        def handler(request):
            return httpx.Response(429,json={'error':{'code':'usage_limit_reached'}})
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)),patch.dict(gateway.PORTS,{'a':4001,'b':4002},clear=True),patch.object(gateway,'account',lambda slot:{'connected':slot=='a'}):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client=upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                    self.assertEqual((await client.post('/admin/select/b',headers={'X-Gateway-Admin':'1'})).status_code,409)
                    await client.post('/v1/responses',headers={'Authorization':'Bearer '+gateway.KEY},json={'input':'test'})
                    rejected=await client.post('/admin/select/a',headers={'X-Gateway-Admin':'1'})
                    self.assertEqual(rejected.status_code,409)
                    self.assertIn('cooling down',rejected.json()['detail'])

    async def test_manual_selection_does_not_disable_limit_failover(self):
        calls=[]
        def handler(request):
            calls.append(request.url.port)
            if request.url.port==4002:
                return httpx.Response(429,json={'error':{'code':'usage_limit_reached'}})
            return httpx.Response(200,content=b'data: {"type":"response.completed"}\n\n',headers={'content-type':'text/event-stream'})
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)),patch.dict(gateway.PORTS,{'a':4001,'b':4002},clear=True),patch.object(gateway,'account',lambda slot:{'connected':True}):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client=upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                    await client.post('/admin/select/b',headers={'X-Gateway-Admin':'1'})
                    response=await client.post('/v1/responses',headers={'Authorization':'Bearer '+gateway.KEY},json={'input':'test'})
                    self.assertEqual(response.headers['x-gateway-account'],'A')
                    self.assertEqual((await client.get('/health')).json()['active'],'a')
            self.assertEqual(calls,[4002,4001])

    async def test_pending_request_cannot_overwrite_new_manual_choice(self):
        started=asyncio.Event()
        release=asyncio.Event()
        calls=[]
        async def handler(request):
            calls.append(request.url.port)
            if len(calls)==1:
                started.set()
                await release.wait()
            return httpx.Response(200,content=b'data: {"type":"response.completed"}\n\n',headers={'content-type':'text/event-stream'})
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)),patch.dict(gateway.PORTS,{'a':4001,'b':4002},clear=True),patch.object(gateway,'account',lambda slot:{'connected':True}):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
                app.state.client=upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                    pending=asyncio.create_task(client.post('/v1/responses',headers={'Authorization':'Bearer '+gateway.KEY},json={'input':'test'}))
                    await asyncio.wait_for(started.wait(),5)
                    try:
                        self.assertEqual((await client.post('/admin/select/b',headers={'X-Gateway-Admin':'1'})).status_code,200)
                    finally:
                        release.set()
                    self.assertEqual((await pending).headers['x-gateway-account'],'A')
                    self.assertEqual((await client.get('/health')).json()['active'],'b')
                    next_response=await client.post('/v1/responses',headers={'Authorization':'Bearer '+gateway.KEY},json={'input':'next'})
                    self.assertEqual(next_response.headers['x-gateway-account'],'B')
            self.assertEqual(calls,[4001,4002])

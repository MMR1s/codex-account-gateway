import asyncio
import base64
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import httpx
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import gateway_images
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==')

class GatewayImageToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_generation_uses_loopback_subscription_route_and_saves_image(self):
        calls=[]
        def handler(request):
            calls.append(request)
            return httpx.Response(200,json={'data':[{'b64_json':base64.b64encode(PNG).decode()}]},headers={'X-Gateway-Account':'b'})
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); (root/'gateway-key.txt').write_text('private-test-key')
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            with patch.object(gateway_images,'STATE',root),patch.object(gateway_images,'SAVE_ROOT',root/'images'),patch.object(gateway_images.httpx,'AsyncClient',return_value=client):
                path,content,mime,slot=await gateway_images.generate('blue circle')
            self.assertEqual(path.read_bytes(),PNG)
            self.assertEqual(slot,'b'); self.assertEqual(mime,'image/png')
            self.assertEqual(str(calls[0].url),'http://127.0.0.1:4000/v1/images/generations')
            self.assertEqual(calls[0].headers['authorization'],'Bearer private-test-key')
            self.assertNotIn('api.openai.com',str(calls[0].url))

    async def test_limit_is_not_retried_and_never_falls_back_to_paid_api(self):
        calls=[]
        def handler(request):
            calls.append(request); return httpx.Response(429,json={'error':'limited'})
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'gateway-key.txt').write_text('private-test-key')
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            with patch.object(gateway_images,'STATE',root),patch.object(gateway_images.httpx,'AsyncClient',return_value=client):
                with self.assertRaisesRegex(RuntimeError,'HTTP 429'):
                    await gateway_images.generate('test')
            self.assertEqual(len(calls),1)

    async def test_stdio_server_initializes_and_exposes_image_tool(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        params=StdioServerParameters(command=sys.executable,args=[str(Path(gateway_images.__file__).resolve())])
        async with stdio_client(params) as (read,write):
            async with ClientSession(read,write) as session:
                await session.initialize()
                tools=await session.list_tools()
                self.assertIn('generate_image',[tool.name for tool in tools.tools])

    def test_edit_requires_explicit_supported_local_images(self):
        with self.assertRaises(ValueError): gateway_images.reference_images(['relative.png'])
        with self.assertRaises(ValueError): gateway_images.reference_images(['x']*6)
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'reference.png';p.write_bytes(PNG)
            self.assertTrue(gateway_images.reference_images([str(p)])[0]['image_url'].startswith('data:image/png;base64,'))

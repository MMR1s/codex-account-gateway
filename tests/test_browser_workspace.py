import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gateway
from browser_workspace import BrowserWorkspace
import httpx


class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_routes_require_dashboard_or_gateway_auth(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(gateway, 'STATE', Path(temp)):
            app = gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
                self.assertEqual((await client.get('/admin/browser/status')).status_code, 403)
                self.assertEqual((await client.get('/v1/browser/status')).status_code, 401)
                headers = {'X-Gateway-Admin': '1'}
                response = await client.get('/admin/browser/status', headers=headers)
                self.assertEqual(response.status_code, 200)
                self.assertFalse(response.json()['running'])
                self.assertEqual((await client.post('/admin/browser/control', json={'action': 'tabs'}, headers={**headers, 'Origin': 'https://evil.example'})).status_code, 403)
                self.assertEqual((await client.get('/browser')).status_code, 200)

    async def test_proxy_preserves_pending_approval_and_validates_payloads(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(gateway, 'STATE', Path(temp)), patch.object(BrowserWorkspace, 'request', new_callable=AsyncMock) as request:
            request.return_value = (202, {'pendingApproval': True, 'approvalId': 'example-id'})
            app = gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver', headers={'X-Gateway-Admin': '1'}) as client:
                response = await client.post('/admin/browser/control', json={'action': 'fill', 'text': 'draft'})
                self.assertEqual(response.status_code, 202)
                self.assertTrue(response.json()['pendingApproval'])
                self.assertEqual((await client.post('/admin/browser/control', json=[])).status_code, 400)
                self.assertEqual((await client.get('/admin/browser/approvals/not-a-uuid')).status_code, 400)

    def test_private_connection_file_cannot_redirect_to_arbitrary_addresses(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            workspace = BrowserWorkspace(state, state)
            for value in [{'port': 80, 'token': 'a' * 64}, {'port': '4000/evil', 'token': 'a' * 64}, {'port': 4100, 'token': 'unsafe'}]:
                (state / 'browser-session.json').write_text(json.dumps(value))
                self.assertIsNone(workspace.connection())

    async def test_state_response_does_not_include_connection_credentials(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(BrowserWorkspace, 'request', new_callable=AsyncMock) as request:
            request.return_value = (200, {'running': True, 'tabs': []})
            result = await BrowserWorkspace(Path(temp), Path(temp)).status()
            self.assertNotIn('token', result)
            self.assertNotIn('port', result)


if __name__ == '__main__':
    unittest.main()

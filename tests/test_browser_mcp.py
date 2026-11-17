import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gateway_browser


class BrowserMCPTests(unittest.IsolatedAsyncioTestCase):
    async def test_api_operation_bridge_preserves_parameters_and_does_not_grant_approval(self):
        with patch.object(gateway_browser, 'request', new_callable=AsyncMock) as request:
            request.return_value = {'state':'awaiting-approval'}
            result = await gateway_browser.browser_api('api_call','send-once',tab_id='tab1',operation_id='saved-op',args={'body_message':'draft'})
            self.assertEqual(result['state'],'awaiting-approval')
            body=request.call_args.args[2]
            self.assertEqual(body['action']['operationId'],'saved-op')
            self.assertEqual(body['action']['args'],{'body_message':'draft'})
            self.assertNotIn('authorized',body)

    async def test_agent_action_preserves_request_id_and_pending_state(self):
        with patch.object(gateway_browser, 'request', new_callable=AsyncMock) as request:
            request.return_value = {'state': 'awaiting-approval', 'approvalId': 'approval1'}
            result = await gateway_browser.browser_action('fill', 'draft1', tab_id='tab1', ref='r1234abcd-1', text='A draft')
            self.assertEqual(result['state'], 'awaiting-approval')
            body = request.call_args.args[2]
            self.assertEqual(body['requestId'], 'draft1')
            self.assertEqual(body['action']['tabId'], 'tab1')
            self.assertNotIn('authorized', body)

    async def test_stdio_server_exposes_read_and_action_tools_without_credentials(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        with tempfile.TemporaryDirectory() as temp:
            params = StdioServerParameters(command=sys.executable,
                args=[str(Path(gateway_browser.__file__))],
                env={**os.environ, 'CODEX_GATEWAY_STATE_DIR': temp})
            async with asyncio.timeout(25):
                async with stdio_client(params) as (reader, writer):
                    async with ClientSession(reader, writer) as session:
                        await session.initialize()
                        tools = {tool.name: tool for tool in (await session.list_tools()).tools}
                        self.assertIn('browser_action', tools)
                        self.assertIn('browser_read', tools)
                        self.assertIn('browser_request_status', tools)
                        self.assertIn('browser_api', tools)
                        self.assertIn('browser_api_operations', tools)
                        self.assertTrue(tools['browser_read'].annotations.readOnlyHint)
                        result = await session.call_tool('browser_state', {})
                        self.assertTrue(result.isError)


if __name__ == '__main__':
    unittest.main()

import unittest
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
import httpx
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import gateway
from agent_guide import guide_html,guide_text

class AgentGuideTests(unittest.IsolatedAsyncioTestCase):
    async def test_guide_is_fetchable_without_credentials_and_matches_dashboard(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)):
            app=gateway.router_app()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
                plain=await client.get('/llms.txt'); markdown=await client.get('/guide.md'); page=await client.get('/guide')
                self.assertEqual(plain.status_code,200)
                self.assertTrue(plain.headers['content-type'].startswith('text/plain'))
                self.assertEqual(plain.text,markdown.text)
                self.assertEqual(plain.text,guide_text(gateway.HERE))
                self.assertIn(guide_html(plain.text),page.text)
                self.assertIn('data-route="guide"',page.text)
                self.assertNotIn('<!--AGENT_GUIDE-->',page.text)
                self.assertNotIn(gateway.KEY,page.text)
                self.assertNotIn(gateway.INTERNAL_KEY,plain.text)
                self.assertEqual((await client.get('/assets/agent_guide.py')).status_code,404)
                self.assertEqual((await client.get('/llms.txt',headers={'Host':'external.example'})).status_code,403)

    def test_render_escapes_code_and_html_and_has_valid_navigation_targets(self):
        rendered=guide_html('# Test\n## 01 · Connect safely\n<script>alert(1)</script>\n```json\n{"input":"<secret>"}\n```\n| A | B |\n| --- | --- |\n| <value> | two |')
        self.assertIn('id="guide-01-connect-safely"',rendered)
        self.assertNotIn('<script>',rendered)
        self.assertIn('&lt;secret&gt;',rendered)
        self.assertIn('<thead>',rendered)
        self.assertIn('&lt;value&gt;',rendered)

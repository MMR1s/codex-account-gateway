import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import tempfile
import unittest
from telemetry import Telemetry, normalize_quota

class TelemetryTests(unittest.TestCase):
    def test_quota_whitelist_and_windows(self):
        quota=normalize_quota({'email':'private@example.test','account_id':'private','plan_type':'plus','rate_limit':{'primary_window':{'used_percent':18,'limit_window_seconds':18000,'reset_at':123},'secondary_window':{'used_percent':27,'limit_window_seconds':604800,'reset_at':456}}})
        self.assertEqual(quota['windows'][0]['remaining_percent'],82)
        self.assertEqual(quota['windows'][1]['label'],'Weekly')
        self.assertNotIn('private',str(quota))
    def test_missing_allowance_is_not_zero(self):
        self.assertEqual(normalize_quota({'rate_limit':None})['state'],'unavailable')
    def test_durable_totals_without_double_counting(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);ledger=Telemetry(state)
            ledger.record('a','test-model','completed',{'input_tokens':100,'output_tokens':20,'input_tokens_details':{'cached_tokens':80},'output_tokens_details':{'reasoning_tokens':5}},1.5)
            ledger.record('a','test-model','interrupted',None,2)
            ledger.quota('a',{'state':'available'})
            result=Telemetry(state).summary()['accounts']['a']
            self.assertEqual(result['input_tokens']+result['output_tokens'],120)
            self.assertEqual(result['metered'],1)
            self.assertEqual(result['attempts'],2)
            self.assertEqual(Telemetry(state).quota('a')['state'],'available')

import math
import unittest
from dataclasses import replace
from core.costs import Scenario, estimate

class Costs(unittest.TestCase):
    def test_mixed_growth_pays_metadata_before_source_bytes(self):
        r = estimate()
        self.assertAlmostEqual(r['new_sources'], 50 * 2**20 * 30 / (40 * 1024))
        self.assertAlmostEqual(r['new_chats'], 50 * 2**20 * 30 / (9 * 1024))
        self.assertAlmostEqual(r['charged_mib_per_day'], 100)
    def test_floor_and_burst(self):
        r = estimate(Scenario(source_share=1, source_kib=1, daily_mib=1000))
        self.assertAlmostEqual(r['new_sources'], 192 * 2**20 * 30 / 16384)
    def test_history_is_not_annual_burst_credit(self):
        a = estimate(Scenario(years=2)); b = estimate(Scenario(years=2, saved_credit_mib=200))
        self.assertAlmostEqual(b['new_sources'] - a['new_sources'], 200 * 2**20 * .5 / (40 * 1024))
        self.assertGreater(a['sql_gb_end'], 10)
        self.assertTrue(any('hard limit' in w for w in a['warnings']))
    def test_backup_frequency_does_not_write_primary_metadata(self):
        a = estimate(Scenario(incremental_every_days=0))
        b = estimate(Scenario(incremental_every_days=1/24))
        self.assertEqual(a['usage']['sql_rows_written'], b['usage']['sql_rows_written'])
        self.assertEqual(a['sql_gb_end'], b['sql_gb_end'])
        self.assertGreater(b['backup_http_requests'], a['backup_http_requests'])

    def test_backup_batching_changes_requests_not_stored_bytes(self):
        a = estimate(Scenario(years=1)); b = estimate(Scenario(years=1, metadata_batch=1))
        self.assertLess(a['backup_http_requests'], b['backup_http_requests'])
        self.assertEqual(a['sql_gb_end'], b['sql_gb_end'])
        self.assertEqual(a['usage']['r2_b'], b['usage']['r2_b'])
    def test_all_sources_and_all_chat(self):
        a = estimate(Scenario(source_share=1)); b = estimate(Scenario(source_share=0))
        self.assertEqual(a['new_chats'], 0); self.assertEqual(b['new_sources'], 0)
        self.assertEqual(b['usage']['r2_a'], 0)
        self.assertEqual(b['usage']['r2_gb_months'], 0)
    def test_idle_has_no_admitted_growth_but_backup_and_subscription_cost(self):
        r = estimate(Scenario(utilization=0, reads=0))
        self.assertEqual(r['new_sources'], 0); self.assertEqual(r['new_chats'], 0)
        self.assertIsNone(r['sql_capacity_days_from_empty_estimate'])
        self.assertGreater(r['backup_http_requests'], 0); self.assertGreaterEqual(r['total_usd'], 5)
    def test_rejections_are_not_a_cost_cap(self):
        a = estimate(); b = estimate(Scenario(extra_worker_requests=100_000_000, extra_do_requests=100_000_000))
        self.assertGreater(b['total_usd'], a['total_usd'] + 40)
        self.assertEqual(a['new_sources'], b['new_sources'])
    def test_independent_custody_cost_is_explicit(self):
        a = estimate(); b = estimate(Scenario(backup_gb_price=.02))
        self.assertAlmostEqual(b['total_usd'] - a['total_usd'], b['archive_gb_end'] * 4 * .02)
    def test_incremental_copies_old_bodies_only_in_full_backups(self):
        full = estimate(Scenario(years=1, backup_every_days=1))
        delta = estimate(Scenario(years=1, incremental_every_days=1/24))
        self.assertEqual(delta['incremental_copies_this_month'], 720)
        self.assertLess(delta['backup_source_gets'], full['backup_source_gets'])
        self.assertAlmostEqual(delta['backup_source_gets'],
            estimate(Scenario(years=1))['backup_source_gets'] + delta['new_sources'])
        self.assertEqual(delta['new_sources'], full['new_sources'])
        self.assertGreater(delta['retained_archive_gb_estimate'], delta['archive_gb_end'] * 4)
    def test_invalid_inputs(self):
        for s in [Scenario(source_share=2), Scenario(cpu_ms=math.nan), Scenario(reads=-1),
                  Scenario(backup_every_days=0), Scenario(metadata_batch=33), Scenario(source_kib=257),
                  Scenario(chat_kib=9), Scenario(saved_credit_mib=201), Scenario(incremental_every_days=8)]:
            with self.subTest(s=s), self.assertRaises(ValueError): estimate(s)

if __name__ == '__main__': unittest.main()

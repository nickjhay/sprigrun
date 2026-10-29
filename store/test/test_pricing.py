"""Run from project root: python3 -m unittest discover -s test -p 'test_*.py'."""
from dataclasses import replace
import unittest

from pricing import Prices, Scenario, Usage, bill, estimate


class PricingTests(unittest.TestCase):
    def test_official_worker_example(self):
        # Cloudflare's 15M requests at 7ms example totals $8 before other products.
        self.assertAlmostEqual(sum(bill(Usage(worker_requests=15_000_000, worker_cpu_ms=105_000_000)).values()), 8)

    def test_billing_unit_boundaries(self):
        self.assertEqual(bill(Usage(r2_a=1_000_000))["R2 Class A writes"], 0)
        self.assertEqual(bill(Usage(r2_a=1_000_001))["R2 Class A writes"], 4.5)
        self.assertEqual(bill(Usage(r2_b=10_000_001))["R2 Class B reads"], 0.36)
        self.assertAlmostEqual(bill(Usage(r2_gb_months=10.1))["R2 source storage"], 0.015)
        self.assertEqual(bill(Usage(do_gb_seconds=400_001))["DO duration"], 12.5)
        self.assertEqual(bill(Usage(do_requests=1_000_001))["DO requests"], 0.15)

    def test_default_quota_envelope(self):
        result = estimate()
        self.assertEqual(result["new_blobs"], 384_000)
        self.assertEqual(result["full_credit_month_reservation_ceiling"], 409_600)
        self.assertEqual(result["rolling_24h_debit_ceiling_mib"], 200)
        self.assertEqual(result["usage"]["do_requests"], 4_152_000)
        self.assertEqual(result["costs_usd"]["DO duration"], 0)
        burst = estimate(Scenario(spend_saved_credit=True))
        self.assertEqual(burst["new_blobs"], 409_600)
        self.assertEqual(burst["source_start_gb"], result["source_start_gb"])

    def test_public_reads_include_authoritative_metadata(self):
        no_reads = estimate(Scenario(reads=0))
        reads = estimate(Scenario(reads=1000))
        self.assertEqual(reads["usage"]["do_requests"] - no_reads["usage"]["do_requests"], 1000)
        self.assertEqual(reads["usage"]["sql_rows_read"] - no_reads["usage"]["sql_rows_read"], 2000)
        self.assertEqual(reads["usage"]["r2_a"], no_reads["usage"]["r2_a"])

    def test_floor_is_accounting_not_padding(self):
        ordinary, tiny = estimate(), estimate(Scenario(average_blob_kib=1))
        self.assertEqual(tiny["new_blobs"], ordinary["new_blobs"])
        self.assertAlmostEqual(tiny["source_added_gb"], ordinary["source_added_gb"] / 8)
        self.assertEqual(tiny["sqlite_end_gb_estimate"], ordinary["sqlite_end_gb_estimate"])

    def test_all_admission_limits_apply(self):
        self.assertEqual(estimate(Scenario(burst_mib_per_hour=1))["admitted_debit_mib"], 720)
        self.assertEqual(estimate(Scenario(minimum_debit_kib=1, average_blob_kib=1))["new_blobs"], 1_296_000)
        self.assertEqual(estimate(Scenario(utilization=0))["new_blobs"], 0)

    def test_daily_peak_average_and_receipt_ceiling(self):
        result = estimate(Scenario(years=0))
        self.assertAlmostEqual(result["usage"]["r2_gb_months"], result["source_added_gb"] * 31 / 60)
        self.assertTrue(any("10 GB limit" in w for w in estimate(Scenario(years=5))["warnings"]))

    def test_attack_traffic_costs_without_growing_storage(self):
        basic = estimate()
        attack = estimate(Scenario(extra_worker_requests=20_000_000, extra_do_requests=20_000_000))
        self.assertEqual(attack["source_end_gb"], basic["source_end_gb"])
        self.assertGreater(attack["total_usd"], basic["total_usd"])
        shared = estimate(p=replace(Prices(), do_gb_seconds_included=0))
        self.assertEqual(shared["costs_usd"]["DO duration"], 12.5)

    def test_challenges_add_requests_and_bounded_storage(self):
        basic = estimate()
        extra = estimate(Scenario(extra_challenges=100_000))
        self.assertEqual(basic["live_ticket_ceiling"], 330)
        self.assertEqual(basic["ticket_storage_gb_ceiling"], 512 * 512 / 1e9)
        self.assertEqual(extra["usage"]["worker_requests"] - basic["usage"]["worker_requests"], 100_000)
        self.assertEqual(extra["usage"]["do_requests"] - basic["usage"]["do_requests"], 100_000)
        self.assertEqual(extra["usage"]["sql_rows_written"] - basic["usage"]["sql_rows_written"], 500_000)
        self.assertEqual(extra["source_end_gb"], basic["source_end_gb"])
        self.assertEqual(extra["ticket_storage_gb_ceiling"], basic["ticket_storage_gb_ceiling"])
        self.assertEqual(basic["costs_usd"]["DO requests"], 0.60)
        self.assertEqual(estimate(Scenario(challenges_per_minute=1))["new_blobs"], 43_200)

    def test_bad_scenarios_fail_clearly(self):
        for changes in ({"daily_mib": -1}, {"reads": -1}, {"years": float('nan')},
                        {"minimum_debit_kib": 0}, {"average_blob_kib": 0}, {"average_blob_kib": 1025},
                        {"utilization": 2}, {"burst_mib": 0}, {"challenge_capacity": 0},
                        {"challenge_capacity": 1.5}, {"challenge_ttl_seconds": 3601}):
            with self.assertRaises(ValueError):
                estimate(Scenario(**changes))


if __name__ == '__main__':
    unittest.main()

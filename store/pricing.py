#!/usr/bin/env python3
"""Editable, standard-library-only cost model for the source-only blob store.

    python3 pricing.py
    python3 pricing.py --daily-mib 100 --reads 12000000 --years 1 3 5
    python3 pricing.py --average-blob-kib 1 --receipt-bytes 1024
    python3 pricing.py --extra-worker-requests 10000000 --extra-do-requests 10000000
    python3 pricing.py --years 0 1 3 --json

Import Scenario, Prices, Usage, estimate and bill for experiments in Python.
Prices checked 2026-10-27 (USD; Workers Paid, R2 Standard, SQLite DO):
https://developers.cloudflare.com/workers/platform/pricing/
https://developers.cloudflare.com/r2/pricing/
https://developers.cloudflare.com/durable-objects/platform/pricing/

This is a scenario model, NOT a bill cap. It assumes allowances are available
to this service; edit Prices for remaining account allowances. All network blob
GETs/HEADs cost a Worker request, one DO metadata RPC and conservatively one R2
read, including 304s. Refused/missing metadata can avoid the R2 read.
Browser cache hits never reach the service and are excluded from --reads.
The modeled challenge-first uploads use two Worker requests, three DO RPCs and
one R2 PUT. Direct no-work POST uses one Worker request, two DO RPCs and no ticket
rows. This model over-allocates upload overhead for that path. An automatic
client's rejected POST before a challenge needs one extra Worker/DO request and
attempt credit when work is enabled; account for it in extra request counts.
The model additionally allows one R2 read per upload for reconciliation; the
common new-object path does not need that read. Preparation and publication
metadata commits share the publish RPC; they add no R2 copy or second PUT. Backup
exports/restores and explicit reclamation belong in the extra-operation counts.
Challenge issuance uses a receipt lookup, with no R2 request. Outstanding tickets
add an indexed insert/delete pair and issuance-counter update per ticket.
--extra-challenges models additional successfully issued, abandoned tickets;
rejected/replayed traffic belongs in --extra-worker-requests/--extra-do-requests.
R2 misses may not be billed; counting them is conservative. Failed/retried
traffic, stats and preflights belong in the explicit extra operation counts.

All modeled blobs have the representative size; a mixture of sizes requires
separate scenarios because mean(max(size, floor)) != max(mean(size), floor).
Quota utilization applies to charged bytes, not physical bytes. No deletions,
deduplication, failed reservations or accumulated backlog completions are assumed.
Age is the START of the modeled month. Storage uses mean end-of-day inventories
for a 30-day month; --spend-saved-credit adds one month's credit, not every month.

Receipt bytes and SQL row counts are estimates, not measurements. Measure the
SQLite database (including indexes/internal metadata) before relying on them.
The single DO is conservatively assumed active all month at 0.128 GB. R2 and DO
compute overages use whole billing units. SQL overages also round up here as a
conservative planning allowance; verify actual SQL invoicing above the free tier.
Workers request/CPU overages are prorated. Taxes, domains, frontend, WAF plans,
logs, external services and non-default Cloudflare features are excluded.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
import math

MIB = 2**20
KIB = 2**10
GB = 10**9
MILLION = 10**6
DAYS = 30


@dataclass(frozen=True)
class Prices:
    workers_base: float = 5.0
    worker_requests_included: float = 10 * MILLION
    worker_requests_per_million: float = 0.30
    worker_cpu_ms_included: float = 30 * MILLION
    worker_cpu_per_million_ms: float = 0.02
    r2_gb_months_included: float = 10
    r2_per_gb_month: float = 0.015
    r2_a_included: float = MILLION
    r2_a_per_million: float = 4.50
    r2_b_included: float = 10 * MILLION
    r2_b_per_million: float = 0.36
    do_requests_included: float = MILLION
    do_requests_per_million: float = 0.15
    do_gb_seconds_included: float = 400_000
    do_per_million_gb_seconds: float = 12.50
    sql_gb_months_included: float = 5
    sql_per_gb_month: float = 0.20
    sql_reads_included: float = 25_000 * MILLION
    sql_reads_per_million: float = 0.001
    sql_writes_included: float = 50 * MILLION
    sql_writes_per_million: float = 1.0


@dataclass(frozen=True)
class Usage:
    """Monthly metered totals; can also be populated from actual measurements."""
    worker_requests: float = 0
    worker_cpu_ms: float = 0
    r2_gb_months: float = 0
    r2_a: float = 0
    r2_b: float = 0
    do_requests: float = 0
    do_gb_seconds: float = 0
    sql_gb_months: float = 0
    sql_rows_read: float = 0
    sql_rows_written: float = 0


def check_nonnegative(values: object) -> None:
    for name, value in asdict(values).items():
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"{name} must be finite and nonnegative")


def overage(used: float, included: float, unit: float, rate: float, *, rounded=True) -> float:
    units = max(0, used - included) / unit
    return (math.ceil(units) if rounded else units) * rate


def bill(u: Usage, p: Prices = Prices()) -> dict[str, float]:
    check_nonnegative(u)
    check_nonnegative(p)
    return {
        "Workers subscription": p.workers_base,
        "Worker requests": overage(u.worker_requests, p.worker_requests_included, MILLION, p.worker_requests_per_million, rounded=False),
        "Worker CPU": overage(u.worker_cpu_ms, p.worker_cpu_ms_included, MILLION, p.worker_cpu_per_million_ms, rounded=False),
        "R2 source storage": overage(u.r2_gb_months, p.r2_gb_months_included, 1, p.r2_per_gb_month),
        "R2 Class A writes": overage(u.r2_a, p.r2_a_included, MILLION, p.r2_a_per_million),
        "R2 Class B reads": overage(u.r2_b, p.r2_b_included, MILLION, p.r2_b_per_million),
        "R2 egress": 0.0,
        "DO requests": overage(u.do_requests, p.do_requests_included, MILLION, p.do_requests_per_million),
        "DO duration": overage(u.do_gb_seconds, p.do_gb_seconds_included, MILLION, p.do_per_million_gb_seconds),
        "SQLite receipt storage": overage(u.sql_gb_months, p.sql_gb_months_included, 1, p.sql_per_gb_month),
        "SQLite rows read": overage(u.sql_rows_read, p.sql_reads_included, MILLION, p.sql_reads_per_million),
        "SQLite rows written": overage(u.sql_rows_written, p.sql_writes_included, MILLION, p.sql_writes_per_million),
    }


@dataclass(frozen=True)
class Scenario:
    # Change these defaults freely, or override them on the command line.
    daily_mib: float = 100
    long_capacity_mib: float = 200
    burst_mib: float = 8
    burst_mib_per_hour: float = 8
    attempts_per_minute: float = 30
    attempt_capacity: float = 30
    challenges_per_minute: float = 30
    challenge_burst: float = 30
    challenge_capacity: float = 512
    challenge_ttl_seconds: float = 600
    ticket_bytes: float = 512  # Estimated SQL allocation per outstanding ticket.
    extra_challenges: int = 0  # Successfully issued extras; expiry deletion included.
    minimum_debit_kib: float = 8
    average_blob_kib: float = 8
    utilization: float = 1
    years: float = 3
    reads: int = 3_000_000
    cpu_ms: float = 3  # Worker CPU per invocation; NOT elapsed request time.
    receipt_bytes: float = 512  # Includes estimated index/page/metadata overhead.
    budget: float = 10
    spend_saved_credit: bool = False
    extra_worker_requests: int = 0
    extra_do_requests: int = 0
    extra_r2_a: int = 0
    extra_r2_b: int = 0


def estimate(s: Scenario = Scenario(), p: Prices = Prices()) -> dict:
    check_nonnegative(s)
    if not 0 <= s.utilization <= 1:
        raise ValueError("utilization must be between 0 and 1")
    if s.minimum_debit_kib <= 0 or s.average_blob_kib <= 0:
        raise ValueError("minimum debit and representative size must be positive (empty uploads deduplicate)")
    if s.average_blob_kib > 1024:
        raise ValueError("source runtime has a 1 MiB hard ceiling")
    if not 1 <= s.challenge_capacity <= 10000 or not float(s.challenge_capacity).is_integer():
        raise ValueError("challenge_capacity must be an integer from 1 through 10000")
    if not 1 <= s.challenge_ttl_seconds <= 3600:
        raise ValueError("challenge_ttl_seconds must be from 1 through 3600")
    size = s.average_blob_kib * KIB
    debit = max(size, s.minimum_debit_kib * KIB)
    if debit > min(s.long_capacity_mib, s.burst_mib) * MIB:
        raise ValueError("a blob's debit must fit both bucket capacities")

    # The three independent steady limits all apply. Credit is not annual growth.
    steady_objects_per_day = min(
        s.daily_mib * MIB / debit,
        s.burst_mib_per_hour * 24 * MIB / debit,
        s.attempts_per_minute * 1440,
        s.challenges_per_minute * 1440,
    ) * s.utilization
    window_mib = min(s.long_capacity_mib + s.daily_mib * DAYS,
                     s.burst_mib + s.burst_mib_per_hour * 24 * DAYS)
    window_max_objects = math.floor(min(window_mib * MIB / debit,
                                       s.attempt_capacity + s.attempts_per_minute * 1440 * DAYS,
                                       s.challenge_burst + s.challenges_per_minute * 1440 * DAYS))
    new_objects = math.floor(window_max_objects * s.utilization) if s.spend_saved_credit else math.floor(steady_objects_per_day * DAYS)
    prior_objects = math.floor(steady_objects_per_day * 365 * s.years)
    source_start_gb = prior_objects * size / GB
    source_added_gb = new_objects * size / GB
    # Uniform writes over the month: the daily peaks are 1/30 ... 30/30.
    average_objects = prior_objects + new_objects * (DAYS + 1) / (2 * DAYS)
    issued = new_objects + s.extra_challenges
    worker_requests = s.reads + new_objects + issued + s.extra_worker_requests
    ticket_storage_gb = s.challenge_capacity * s.ticket_bytes / GB if issued else 0
    live_ticket_ceiling = min(s.challenge_capacity, math.ceil(s.challenge_burst + s.challenges_per_minute * s.challenge_ttl_seconds / 60))
    usage = Usage(
        worker_requests=worker_requests,
        worker_cpu_ms=worker_requests * s.cpu_ms,
        r2_gb_months=average_objects * size / GB,
        r2_a=new_objects + s.extra_r2_a,
        r2_b=s.reads + new_objects + s.extra_r2_b,
        do_requests=s.reads + 2 * new_objects + issued + s.extra_do_requests,
        do_gb_seconds=DAYS * 86400 * 0.128,
        sql_gb_months=average_objects * s.receipt_bytes / GB + ticket_storage_gb,
        # Conservative rough counts including indexed receipt work, worst-case
        # ticket-count scans, and eventual expiry deletions. Extra RPCs
        # allow two reads and one write each; use Usage directly for measured SQL.
        sql_rows_read=2 * s.reads + 8 * new_objects + issued * (s.challenge_capacity + 4) + 2 * s.extra_do_requests,
        sql_rows_written=8 * new_objects + 5 * issued + s.extra_do_requests,
    )
    costs = bill(usage, p)
    total = sum(costs.values())
    sql_end_gb = (prior_objects + new_objects) * s.receipt_bytes / GB + ticket_storage_gb
    warnings = []
    if issued > s.challenge_burst + s.challenges_per_minute * 1440 * DAYS:
        warnings.append("Requested successful ticket issuance exceeds the configured monthly envelope; increase the rate or model denials as extra requests instead.")
    if s.extra_challenges * s.challenge_ttl_seconds / (DAYS * 86400) > s.challenge_capacity:
        warnings.append("Abandoned-ticket occupancy would exceed the table cap at a uniform rate; some requests must be denied.")
    if total > s.budget:
        warnings.append("Modeled monthly cost exceeds the chosen budget.")
    if sql_end_gb >= 10:
        warnings.append("Estimated receipts reach the single paid SQLite DO's 10 GB limit; this projection needs an architectural change.")
    if s.average_blob_kib > 256:
        warnings.append("Representative blob exceeds the default 256 KiB admission cap; change MAX_BLOB_BYTES to use this scenario.")
    return {
        "scenario": asdict(s), "usage": asdict(usage), "costs_usd": costs,
        "total_usd": total, "budget_headroom_usd": s.budget - total,
        "issued_challenges": issued, "live_ticket_ceiling": live_ticket_ceiling,
        "ticket_storage_gb_ceiling": ticket_storage_gb,
        "new_blobs": new_objects, "admitted_debit_mib": new_objects * debit / MIB,
        "source_start_gb": source_start_gb, "source_added_gb": source_added_gb,
        "source_end_gb": source_start_gb + source_added_gb,
        "sqlite_end_gb_estimate": sql_end_gb,
        "full_credit_month_reservation_ceiling": window_max_objects,
        "rolling_24h_debit_ceiling_mib": min(s.long_capacity_mib + s.daily_mib, s.burst_mib + 24 * s.burst_mib_per_hour),
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    defaults = asdict(Scenario())
    for name, value in defaults.items():
        flag = "--" + name.replace("_", "-")
        if name == "years":
            parser.add_argument(flag, type=float, nargs="+", default=[value], help="age(s) at start of modeled month")
        elif isinstance(value, bool):
            parser.add_argument(flag, action="store_true", help="spend full saved credit once in the modeled month")
        else:
            kind = int if name in {"reads", "extra_worker_requests", "extra_do_requests", "extra_r2_a", "extra_r2_b", "extra_challenges"} else float
            parser.add_argument(flag, type=kind, default=value, help=f"default: {value}")
    parser.add_argument("--json", action="store_true", help="machine-readable results")
    args = vars(parser.parse_args())
    output_json, years = args.pop("json"), args.pop("years")
    try:
        results = [estimate(Scenario(**args, years=year)) for year in years]
    except ValueError as error:
        parser.error(str(error))
    if output_json:
        print(json.dumps({"prices_checked": "2026-10-27", "prices": asdict(Prices()), "results": results}, indent=2))
        return
    print("USD/month estimates · 30-day month · prices checked 2026-10-27")
    print("Age is start of month. SQL size/row costs are estimates; allowances are account-wide.\n")
    for result in results:
        scenario = result["scenario"]
        print(f"Age {scenario['years']:g} years | {scenario['daily_mib']:g} MiB/day | {scenario['reads']:,} network reads")
        print(f"  Tickets issued: {result['issued_challenges']:,}; live ceiling: {result['live_ticket_ceiling']:g}")
        print(f"  New blobs: {result['new_blobs']:,}; debit: {result['admitted_debit_mib']:,.1f} MiB")
        print(f"  Source GB: {result['source_start_gb']:.2f} -> {result['source_end_gb']:.2f}; estimated SQLite: {result['sqlite_end_gb_estimate']:.2f} GB")
        for label, cost in result["costs_usd"].items():
            print(f"  {label:25} ${cost:8.3f}")
        print(f"  {'TOTAL':25} ${result['total_usd']:8.2f}")
        print(f"  Budget headroom: ${result['budget_headroom_usd']:.2f}")
        for warning in result["warnings"]:
            print(f"  NOTE: {warning}")
        print()
    print("Upload quotas bound admissions, not GET/rejected traffic or total spending.")


if __name__ == "__main__":
    main()

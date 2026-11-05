#!/usr/bin/env python3
"""Native phase-0 scenarios; stdlib only. Run from anywhere: python3 core/costs.py --help.

Prices verified 2026-11-03 (Workers Paid, R2 Standard, SQLite Durable Objects):
https://developers.cloudflare.com/workers/platform/pricing/
https://developers.cloudflare.com/r2/pricing/
https://developers.cloudflare.com/durable-objects/platform/pricing/
https://developers.cloudflare.com/durable-objects/platform/limits/

Reuses store.pricing's billing arithmetic, NOT its legacy challenge/receipt model.
An estimate, not a bill cap. Account allowances are shared; edit Prices accordingly.
Rejected traffic still incurs Worker/DO requests. Local elapsed time is not Worker CPU.
No taxes, frontend, WAF plans, domains, logging, restore traffic or external transfer
fees. Optional independent backup storage is an estimate, not a provider quotation.
See OPERATIONS.md for measured allocations and limitations. Never treat the SQL
capacity projection as a guarantee; the single-object 10 GB limit is independent of cost.
"""
from __future__ import annotations
import argparse
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from store.pricing import Prices, Usage, bill, check_nonnegative

KIB, MIB, GB = 2**10, 2**20, 10**9
SQL_LIMIT = 10 * GB

@dataclass(frozen=True)
class Scenario:
    years: float = 0  # START of modeled 30-day month; identical past workload.
    daily_mib: float = 100
    utilization: float = 1
    source_share: float = .5  # Share of charged growth, not POST count.
    source_kib: float = 32
    chat_kib: float = 1
    source_sql_kib: float = 2  # Allocation incl. indexes; estimate from local rehearsal.
    chat_sql_overhead_kib: float = 2  # Plus one inline body; editable estimate.
    reads: float = 3_000_000  # Successful requests reaching this service, not browser hits.
    source_read_share: float = .5  # Others read SQL/listings; HTML is generated, not free ASSETS.
    signed_chat_share: float = .5  # One R2 key-record GET per signed action in current code.
    cpu_ms: float = 3  # Assumed Worker CPU per request. NOT local elapsed latency.
    backup_every_days: float = 7  # Full copies; >0.
    incremental_every_days: float = 0  # 0 disables; otherwise <= full interval.
    metadata_batch: float = 16  # Effective records/request; API max32, byte cap can reduce it.
    backup_copies: float = 4
    backup_gb_price: float = 0  # Set to independent storage provider's price; 0 means excluded.
    extra_worker_requests: float = 0
    extra_do_requests: float = 0
    saved_credit_mib: float = 0  # Spend once during modeled month, at most200; NOT each year.

def estimate(s: Scenario = Scenario(), prices: Prices = Prices()) -> dict:
    check_nonnegative(s)
    for field in ('utilization', 'source_share', 'source_read_share', 'signed_chat_share'):
        if getattr(s, field) > 1: raise ValueError(field + ' must be between 0 and 1')
    if not 0 < s.source_kib <= 256 or not 0 <= s.chat_kib <= 8:
        raise ValueError('representative sizes must fit phase-0 source/chat limits')
    if s.backup_every_days <= 0 or not 1 <= s.metadata_batch <= 32:
        raise ValueError('backup interval must be positive and effective batch must be 1..32')
    if s.incremental_every_days > s.backup_every_days:
        raise ValueError('incremental interval must not exceed full interval')
    if s.saved_credit_mib > 200: raise ValueError('saved credit is capped at 200 MiB')
    size, chat = s.source_kib * KIB, s.chat_kib * KIB
    source_debit, chat_debit = max(size, 8192) + 8192, 8192 + chat
    # Production burst refill and attempt refill both still apply.
    actions_per_byte = s.source_share / source_debit + (1 - s.source_share) / chat_debit
    daily = min(s.daily_mib * MIB, 8 * MIB * 24, 30 * 1440 / actions_per_byte) * s.utilization
    extra = min(s.saved_credit_mib * MIB * s.utilization,
                max(0, (8 * 24 * 30 + 8) * MIB - daily * 30),
                max(0, (30 * 1440 * 30 + 30) / actions_per_byte - daily * 30))
    month = daily * 30 + extra
    history = daily * 365 * s.years
    # Daily peak inventories; saved credit is spread uniformly across the month.
    average = history + month * 31 / 60
    source_rate, chat_rate = s.source_share / source_debit, (1 - s.source_share) / chat_debit
    sources, chats = month * source_rate, month * chat_rate
    stored_sources, stored_chats = average * source_rate, average * chat_rate
    sql_per_charge = source_rate * s.source_sql_kib * KIB + chat_rate * (s.chat_sql_overhead_kib * KIB + chat)
    sql_end = (history + month) * sql_per_charge
    # End-of-month inventory for every export deliberately overestimates this month's backup traffic.
    nsource, nchat = (history + month) * source_rate, (history + month) * chat_rate
    copies = math.ceil(30 / s.backup_every_days)
    deltas = math.ceil(30 / s.incremental_every_days) if s.incremental_every_days else 0
    cut_rate = 1 / s.backup_every_days + (1 / s.incremental_every_days if deltas else 0)
    cuts = math.ceil((365 * s.years + 30) * cut_rate)
    # Conservative: count deltas even at full-copy boundaries, and one request per
    # source body although small bodies can share a batch. Other journal facts batch.
    def export_requests(ns, nc, nk):
        return math.ceil(ns) + math.ceil((ns + nc + nk) / s.metadata_batch) + 2
    window = min(30, s.incremental_every_days)
    delta_sources, delta_chats = sources * window / 30, chats * window / 30
    delta_cuts = math.ceil(window * cut_rate)
    backups = copies * export_requests(nsource, nchat, cuts) + deltas * export_requests(delta_sources, delta_chats, delta_cuts)
    backup_sources = copies * nsource + deltas * delta_sources
    backup_records = copies * (2 * nsource + nchat + cuts) + deltas * (2 * delta_sources + delta_chats + delta_cuts)
    requests = s.reads + sources + chats + backups
    usage = Usage(worker_requests=requests + s.extra_worker_requests,
        worker_cpu_ms=(requests + s.extra_worker_requests) * s.cpu_ms,
        do_requests=requests + s.extra_do_requests,
        do_gb_seconds=.128 * 30 * 86400,  # one always-active DO; includes IO wait
        r2_a=sources,
        r2_b=s.reads * s.source_read_share + chats * s.signed_chat_share + backup_sources,
        r2_gb_months=stored_sources * size / GB,
        sql_gb_months=(average * sql_per_charge + cuts * 4096) / GB,
        # Estimated row operations including indexes; backup scans proportional to records.
        sql_rows_read=(s.reads + sources + chats + s.extra_do_requests) * 32 + backup_records * 8,
        sql_rows_written=sources * 22 + chats * 19 + s.extra_do_requests * 16 + (copies + deltas) * 7)
    costs = bill(usage, prices)
    archive_bytes = nsource * (size + 2048) + nchat * (2048 + chat) + cuts * 4096
    # Retain each full copy plus a full interval's growth as its delta chain.
    suffix_bytes = ((sources * (size + 2048) + chats * (2048 + chat)) * s.backup_every_days / 30
                    + math.ceil(s.backup_every_days * cut_rate) * 4096) if deltas else 0
    retained_archive_bytes = (archive_bytes + suffix_bytes) * s.backup_copies
    costs['Independent backup storage (estimate; zero means excluded)'] = retained_archive_bytes / GB * s.backup_gb_price
    capacity_days = SQL_LIMIT / (daily * sql_per_charge) if daily * sql_per_charge else None
    warnings = []
    if sql_end + cuts * 4096 >= SQL_LIMIT:
        warnings.append('Exceeds one SQLite DO: 10 GB hard limit. Cost arithmetic beyond this point is hypothetical until partitioned.')
    if s.reads > 120 * 1440 * 30:
        warnings.append('Reads exceed the default 120/min steady refill; model those excess attempts as rejections.')
    if s.backup_gb_price == 0: warnings.append('Independent backup storage/transfer fees are excluded.')
    return {'scenario': asdict(s), 'charged_mib_per_day': daily / MIB, 'new_sources': sources,
        'new_chats': chats, 'backup_http_requests': backups, 'backup_copies_this_month': copies,
        'incremental_copies_this_month': deltas, 'backup_source_gets': backup_sources,
        'retained_archive_gb_estimate': retained_archive_bytes / GB,
        'archive_gb_end': archive_bytes / GB, 'sql_gb_end': (sql_end + cuts * 4096) / GB,
        'sql_capacity_days_from_empty_estimate': capacity_days, 'usage': asdict(usage),
        'costs_usd': costs, 'total_usd': sum(costs.values()), 'warnings': warnings}

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for field, value in asdict(Scenario()).items():
        if field != 'years': parser.add_argument('--' + field.replace('_', '-'), type=float, default=value)
    parser.add_argument('--years', nargs='+', type=float, default=[0, .5, 1, 3])
    parser.add_argument('--json', action='store_true')
    args = vars(parser.parse_args()); years, json_output = args.pop('years'), args.pop('json')
    try: results = [estimate(Scenario(years=year, **args)) for year in years]
    except ValueError as e: parser.error(str(e))
    if json_output: print(json.dumps(results, indent=2, allow_nan=False)); return
    print('Age (start) | USD/month | SQL GB (end) | R2 GB-month | Backup HTTP/month')
    for r in results:
        print(f"{r['scenario']['years']:10g} | {r['total_usd']:9.2f} | {r['sql_gb_end']:12.2f} | {r['usage']['r2_gb_months']:11.2f} | {r['backup_http_requests']:17,.0f}")
        for warning in r['warnings']: print('  ' + warning)
    print('Assumptions are editable. This is neither a spending cap nor a capacity guarantee.')

if __name__ == '__main__': main()

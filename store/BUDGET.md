# A roughly $10/month budget

Default: **100 MiB/day of admission refill, with an 8 KiB minimum debit
per new address**, and review the policy as retained source approaches 100 GB.
This is a comfortable starting point for a few years of accumulation, assuming
moderate request traffic. It is a recommendation, not a hard dollar spending cap.
Saved long-term credit is capped at 200 MiB. A second bucket holds at most
8 MiB and refills at 8 MiB/hour. Together these cap new quota admission at
200 MiB in any rolling 24 hours, including after a very long idle period.

Prices below were checked on 27 October 2026. Assume this service pays the full
$5 Workers subscription, uses R2 Standard, and has the account's included
allowances available. Taxes, domain registration, frontend hosting and other
Cloudflare products are outside this estimate.

## Experiment in Python

The standalone [pricing.py](pricing.py) uses only Python's standard library
(Python 3.10+). The `Scenario` and `Prices` dataclasses hold editable defaults.
You can also import `estimate()` or pass measured `Usage` to `bill()`.

```sh
python3 pricing.py
python3 pricing.py --daily-mib 100 --reads 12000000 --years 1 3 5
python3 pricing.py --daily-mib 50 --average-blob-kib 1 --receipt-bytes 1024
python3 pricing.py --extra-worker-requests 10000000 --extra-do-requests 10000000
python3 pricing.py --extra-challenges 100000 --years 1 3
python3 pricing.py --years 0 1 3 --json
```

`--reads` counts network GETs/HEADs, including conditionals, after browser-cache
hits are removed. Each allowed network read now includes one DO metadata lookup
before R2; refused/missing addresses can avoid R2. `--cpu-ms` is average **Worker CPU**, not wall time. Extra
Worker/DO/R2 counts model retries, denied requests, stats, preflights or other
traffic; enter each affected product's count separately. For example, 10 million
PUTs rejected by the global attempt limiter still mean roughly 10 million
extra Worker invocations and DO RPCs, with no extra R2 requests. Requests rejected
before the coordinator contribute only the Worker count.

The default scenario is 100% quota utilization with distinct 8 KiB source blobs,
3 million network reads/month, 3 ms Worker CPU and **an estimated 512 bytes per
SQLite receipt**, including overhead. It costs approximately **$6.05/month after
year one** and **$7.80/month after year three**. With 12 million network reads,
those estimates become **$9.48** and **$11.23**. These model the following 30-day
month, averaging daily peak inventory rather than holding anniversary inventory
constant. Extra traffic is zero in those examples; account allowances are assumed
available. SQL overage rounding is conservative in the model.

For 1 KiB blobs, the same 8 KiB debit buys the same number of receipts but stores
one eighth as many source bytes. Change `--receipt-bytes` to examine metadata
uncertainty, then replace that estimate with database measurements. At 512 bytes
per receipt under saturated defaults, the single DO approaches its 10 GB limit
after about 4.2 years, before indefinite growth is viable. This is an estimated
capacity horizon, not a measured row size. The script flags projections beyond
that limit; they are not runnable configurations without a storage design change.

The default calculation excludes saved credit. `--spend-saved-credit` uses the
combined monthly admission envelope once, not once every month of the service's
history. Utilization and the representative blob size are assumed constant over
the modeled history. Source deletion, duplicate uploads, failed reservations and
completions of old pending writes are not inferred from the byte quota. Use actual
operation/inventory totals via `Usage` for a closer billing estimate.

## Outstanding-ticket cost model (v0.5)

The calculator currently models clients going directly to the challenge workflow.
With work off, `POST /b` instead takes one Worker request, two DO RPCs, one R2 PUT
and no ticket rows for a new object; the calculator's upload allowance is therefore
conservative for that path. A duplicate POST takes one R2 GET and no R2 PUT.
The automatic client first tries POST; when work is enabled, add one extra Worker
and DO request per such attempt using the extra-request fields. That rejected POST
also consumes attempt credit, so the automatic flow's maximum accepted upload rate
can be lower than the challenge-first scenario. No new billing cap is implied.

A challenge-first new blob uses **two Worker requests** (challenge + PUT), **three DO
RPCs** (issue + redeem + publish), one conservative R2 read and one R2 write.
Issuance checks a receipt in SQLite, not R2. Rejected proof/replay requests use one
Worker request and, after cheap edge/header checks, one DO request; no body hash
or R2 call is needed. Unknown proofs still reach the global attempt limiter.

At 384,000 new blobs/month, this adds 384,000 Worker requests and raises upload
DO RPCs from 768,000 to 1,152,000. With otherwise unused allowances, the DO request
charge for uploads alone is $0.15/month. With the default 3 million read lookups,
the total DO request estimate is 4,152,000 and $0.60/month. SQL issuance adds an indexed insert, eventual indexed delete
and rate-counter update per issued ticket; the model allows five extra row writes.
Ticket-count queries conservatively budget a full bounded-table scan. These SQL
operations remain within included allowances for the example workload.

`--extra-challenges` models additional successfully issued, abandoned tickets:
one Worker request, one DO request, and issuance/expiry SQL work each, without
source growth. Excess issuance or impossible sustained occupancy produces a warning;
the model does not simulate an attacker's exact timing. Denied issuance/replay
traffic belongs in the separate extra request fields. Enter extra R2 counts only
when that traffic actually reaches storage. Do not double-count requests.

Challenge refill defaults to 30/minute, burst 30, lifetime ten minutes and table
cap 512. Thus at most 330 tickets are live under an unchanged policy. Storage
planning conservatively allows 512 records at an estimated 512 bytes each, about
256 KiB. This is a logical table estimate, not measured total SQLite allocation;
platform internal metadata also exists. Expiry cleanup is lazy, with no alarms.
The number of abandoned tickets is no longer an unbounded storage commitment.

Difficulty affects client computation, not the number of verifier hash trials:
server verification performs one small hash. Use `--utilization` for a scenario's
assumed source admission, without assuming that PoW guarantees lower traffic or
caps the bill. The browser helper bounds its own solve time and trial count.

## Allocate the budget

| Monthly envelope | Purpose |
| --- | --- |
| $5 | Workers Paid subscription and its included usage |
| $2 | Accumulating R2 source storage |
| $1 | Additional read requests/CPU, if traffic exceeds included usage |
| $2 | Upload/control traffic, receipt metadata, billing rounding and spare room |

This is a planning split, not four separate charges. Serving is largely covered
by the subscription/included allowances; there is no reason to spend the spare
money immediately. At 100 MiB/day, the first year will often be closer to $5–6
per month (about $6.05 in this scenario) than $10 if traffic stays within those allowances.

## Prices that matter

| Resource | Included | Overage |
| --- | --- | --- |
| Worker invocations | 10 million/month in the $5 plan | $0.30/million |
| Worker CPU | 30 million CPU ms/month | $0.02/million CPU ms |
| R2 Standard source storage | 10 GB-month/month | $0.015/GB-month |
| R2 Class A, including PUT | 1 million/month | $4.50/million |
| R2 Class B, including GET | 10 million/month | $0.36/million |
| R2 internet egress | No charge | No charge |
| Durable Object RPC | 1 million/month | $0.15/million |
| Durable Object SQL storage | 5 GB-month/month | $0.20/GB-month |

R2 rounds billable usage up to whole billing units, including million-operation
units. A small overrun of the free PUT allocation can therefore add $4.50.
Durable Object pricing also rounds overages to its billable units. Do not treat
every listed per-million rate as infinitely divisible when estimating a small
bill. Account allocations are shared with other services using the same account.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Storage accumulates

Assume all nominal daily admission becomes new stored source, nothing is deleted,
and ignore the small initial burst credit. The table estimates a monthly R2
storage charge if the inventory reached at each anniversary were held for a
month. Actual bills average daily peak inventories over the billing period.
These figures exclude requests and receipt metadata.

| Refill | New source/year | At year 1 | At year 3 | At year 5 |
| --- | ---: | ---: | ---: | ---: |
| 10 MiB/day | 3.83 GB | $0.00/mo | $0.03/mo | $0.15/mo |
| 50 MiB/day | 19.14 GB | $0.15/mo | $0.72/mo | $1.29/mo |
| **100 MiB/day** | **38.27 GB** | **$0.44/mo** | **$1.58/mo** | **$2.73/mo** |
| 200 MiB/day | 76.55 GB | $1.01/mo | $3.30/mo | $5.60/mo |

Units: MiB = 2^20 bytes; GB = 10^9 bytes. R2 distinguishes these units in its
[limits documentation](https://developers.cloudflare.com/r2/platform/limits/).
For refill `q` MiB/day and age `y` years, the source-only planning formula is:

```text
inventory_GB = q * 2^20 * 365 * y / 10^9
monthly_storage_USD = 0.015 * ceil(max(0, inventory_GB - 10))
```

A $2 storage envelope corresponds to about 143 GB before rounding. Spread across
three years, that is about 125 MiB/day; choosing 100 leaves room. No positive
constant refill can keep a fixed budget forever if all bytes are retained.
For a five-year horizon and a roughly $2 storage allocation, 50–75 MiB/day is
more appropriate. Alternatively revisit admission or design explicit retention.

## Tiny objects change the answer

Charging `max(actual_size, minimum_debit)` bounds receipt and object counts.
With a 100 MiB/day refill and an 8 KiB floor, the steady-state maximum is 12,800
new digests/day: 384,000 in 30 days, or 396,800 in 31 days, plus bounded initial
credit. Including all 200 MiB of long-term credit raises those upper bounds to
409,600 and 422,400 new reservations respectively. This stays well below the
million included PUTs, leaving room for
retries, operator blocks and other writes. Three RPC calls per normal upload give
about 1,152,000 upload RPCs in a fully used 30-day month before stats and retries.

The 8 KiB is an accounting charge, not padding: a 1 KiB source still stores 1 KiB.
Metadata and object-count costs are part of why a floor is useful.

At a 1 KiB floor, the byte budget alone would allow over 3 million tiny objects
per 30 days. The global issuance and attempt limits of 30/minute brings that down
to about 1.296 million successful uploads at most, still enough to cross the
free PUT allocation and add **$4.50/month** in Class A charges alone. Rejected
attempts, duplicate submissions and admin requests have their own operation
costs even when they do not create new source.

A 4 KiB floor would also keep ordinary new PUTs under the included allowance
(768,000 per 30 days); 8 KiB gives more room and halves potential receipt growth.
The floor limits first-time reservations, not every physical write. Old pending
reservations can complete later, while stored addresses remain permanently reserved even after external eviction.
Keep some headroom for those events rather than treating these nominal counts
as an absolute monthly operation ceiling.

## Serving and coordinator costs

Each blob request that reaches the Worker normally performs one R2 read. Browser
cache hits make neither request. At a few million network reads/month, Worker
and R2 request charges usually remain inside the allocations. CPU must also fit:
10 million invocations exhaust 30 million CPU ms at an average of 3 ms each.
Measure production CPU instead of treating emulated wall time as billable CPU.

For an illustrative 12 million network GETs/month plus 384,000 new uploads and
384,000 challenge requests, assuming 3 ms of Worker CPU per request, incremental
Worker request/CPU and R2 read cost is roughly $2.08. Add $0.15 of DO requests,
around $1.61 for source storage in the month following year three, $0.60 of
conservatively rounded estimated receipt storage and the $5 subscription: roughly
$9.43 before extra traffic. This conservatively counts one R2 read per upload even
when an unsuccessful lookup might be free. Preflights, retries, HEADs and stats
must be included in real measurements; they are outside this illustrative workload.

The single coordinator keeps the duration budget favorable: even continuously
active for 31 days at its billed 128 MB allocation, it is below 400,000 included
GB-s. This assumes the allocation is not used by other Durable Objects. SQL
includes 25 billion rows read and 50 million rows written per month; ordinary
usage at this admission rate is well below those figures. Receipt storage still
grows, and the single paid SQLite object has a 10 GB maximum. Monitor its size
alongside R2 inventory; source bytes alone do not describe the entire store.

References: [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and the pricing links above. Private caching remains a sensible default at this
budget; a shared cache can be reconsidered if measured read traffic warrants it.
The byte quota does not bound rejected requests or GET traffic and is not a
hard spending limit under abuse.

## Default configuration

These values are already set in the `vars` object in `wrangler.jsonc`:

```json
{
  "LONG_REFILL_BYTES_PER_DAY": "104857600",
  "LONG_CAPACITY_BYTES": "209715200",
  "MINIMUM_DEBIT_BYTES": "8192",
  "BURST_REFILL_BYTES_PER_HOUR": "8388608",
  "BURST_CAPACITY_BYTES": "8388608"
}
```

This keeps at most 200 MiB of long-term credit, refills it at 100 MiB/day, and
allows at most 8 MiB of immediate burst credit replenished at 8 MiB/hour. The
256 KiB blob cap and separate 30/minute challenge/attempt settings remain in place.

Each token bucket bounds admission by capacity + elapsed refill, and both must
allow each reservation. Therefore, in MiB:

```text
admitted(T) <= min(200 + 100 * T_in_days, 8 + 8 * T_in_hours)
```

This gives at most 16 MiB in any rolling hour and 200 MiB in any rolling 24
hours. A 200 MiB long-term credit cap alone would allow up to 300 MiB over a day
because it also refills; the short-term cap/refill are what tighten that to
200 MiB. Credit never exceeds either capacity, even after years of inactivity.
The existing capped-bucket implementation supplies these bounds without a new
daily counter. Changing these settings changes the derived window bounds.

These are not calendar-day resets. Existing credit is retained when settings change; existing
reservations keep their original debit. Raising the floor does not retroactively
charge old digests. The configuration change does not itself deploy anything.

## October 29 operation-count refinement

The new-object path now attempts its conditional R2 PUT without a preliminary
GET. A failed absence condition is followed by a verified GET for reconciliation.
The model still conservatively budgets one read per new upload; those figures
are an allowance for retries rather than the common-path request count. Pricing
inputs remain the October 27 snapshot.

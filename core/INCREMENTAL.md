# One recovery stream

Implementation slice C; one physical coordinator. Public results and signatures
do not gain a global ordering promise.

The journal holds a monotonic u64 position and a pointer to each immutable source
reservation, accepted result, applied moderation fact or cut. Pause/unpause is a
small inline control fact. The fact, pointer and position commit together. A
rejected attempt, exact retry or GET creates no journal entry. Attempt credit is
mutable operating state: restoration always resets all spendable credit to zero,
so omitting its individual decrements cannot resurrect credit. Cuts retain the
historical bucket values, policy, counters and pause state.

Full and incremental archives share one stream format. A full archive starts at
position zero. A delta starts after a previously witnessed cut and binds that
cut, journal identity and the previous archive's digest. Both stop at a closed
cut. Export is bounded by rows and bytes; source bytes accompany their first
accepted result, never an unpublished reservation. The live journal never copies
payloads and adds no R2 operation to ordinary publication.

Restore validates one bounded record at a time in journal order. Required local
predecessors must already exist. It inserts the fact and journal pointer with the
durable import cursor; a lost acknowledgement can repeat only the identical last
record. Cuts check counters and replayed control state. A full snapshot and every
delta use the same validation and import path.

The restore plan pins an independently trusted final digest before importing.
Finishing an earlier segment leaves the target waiting for its suffix. Wrong
lineage/base, missing positions, reordered/duplicated facts, conflicting retries,
truncation, invalid signatures and broken dependencies cannot complete recovery.
After the final segment, release still requires the explicit history-reconciled
operator assertion, removal of the environment fence and a separate unpause.
No collection number, receipt, acceptance time, reservation or policy is erased.

A digest proves the supplied chain, not that no later writes exist. Operators
must fence the old writer and identify the final trusted cut. If that evidence
is unavailable, keep the target quarantined. The [D1 laboratory](BARRIER.md) now journals partition binding and hold/release
transitions and exercises a durable global barrier. Whole-cluster restore,
cross-owner references and dynamic writer fencing remain later work.

# Maestro participants and lifecycle

The public `MaestroClient` exposes `addParticipant`, `removeParticipant`, `transferOwnership`, `changeThreadState` and `deleteThread`. Callers reserve one immutable idempotency key before I/O and retain it with the exact target, body and expected version when confirmation is unknown. The SDK never retries mutations automatically. Transfer, archive/reopen and deletion send decimal `If-Match`. Deletion accepts only HTTP 202 with a validated `{deletion_job_id,state:'deleting'}` receipt, closes the subscription and clears the local thread. This acknowledges a deletion request, not completion of storage purge.

Management replies are commit receipts and can deliberately contain empty permissions. The SDK reads a fresh authorized projection after a confirmed mutation. The server rechecks Core eligibility, membership, owner constraints, version and key. A local role is never a server grant.

`openSupervision(threadId, reason, key)` acquires a server-audited, thread-bound read-only grant. Use a dedicated client and separately requested `threads:read`/`threads:supervise` token. Only after the method succeeds may that client read or subscribe. Reads send `Maestro-Supervision-Grant`; subscriptions send `supervision_grant_id`. Grant holders cannot call management methods; server checks remain authoritative.

Grants last at most 60 seconds, remain in memory and never renew automatically. Expiry, revocation and `closeThread` clear local history/commands/streams/publications. Revisions fence late HTTP replies. Dispose the old dedicated client and explicitly acquire a new grant to open supervision again. `MaestroClientProvider` binds an already owned client to hooks; the caller owns connect/dispose. Existing provider lifecycle is unchanged.

Live metadata events trigger one coalesced authorized read rather than polling. A projection at the same canonical sequence/version refreshes participants and ownership as well as permissions, so independent tabs converge on transfers represented by `thread.updated`.

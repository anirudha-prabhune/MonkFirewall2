# MonkFirewall2 — Incident Recovery & Operational Runbook

## Overview
This runbook provides standardized operational procedures for monitoring, investigating, and recovering from risk events, broker disconnections, Daily Loss Limit breaches, and system state anomalies in the multi-broker MonkFirewall2 risk engine.

Target Brokers & Accounts:
- **Angel One**: Primary account `acc_mt_angelone_default`, default execution mode `ENFORCE` (or `OBSERVE_ONLY`), Daily Loss Limit ₹10,000, 720-minute lock policy. Read-only position and capital ingestion.
- **Zerodha**: Primary account `acc_mt_zerodha_default`, independent execution mode, thresholds, sessions, and locks.

---

## 1. Investigating Stale P&L and Broker Disconnections

### Symptoms
- Dashboard displays "STALE_DATA_DETECTED" or "BROKER_DISCONNECTED" warning events.
- Position prices or P&L figures show `isStale: true` or `dataSource: 'ANGELONE_DISCONNECTED'`.

### Diagnostic Steps
1. **Check Connection Status**:
   - For Angel One: Call `GET /api/angelone/status`.
   - For Zerodha: Call `GET /api/zerodha/status`.
2. **Verify Upstream Tokens**:
   - Ensure the broker session (`jwtToken` / `accessToken`) has not expired or been invalidated by upstream broker password/TOTP changes.
3. **Fail-Closed Behavior Verification**:
   - Confirm that stale or missing data does **NOT** reset accumulated loss to ₹0 or clear an existing active lock.
   - If an account is currently `LOCKED`, the active lock must remain in force despite broker disconnection.

---

## 2. Responding to 70%/90% Warnings and Daily Loss Limit Breaches

### Threshold Warnings (70% & 90%)
- **70% Loss Utilization (`RISK_WARNING_70`)**: Loss has reached 70% of Daily Loss Limit (e.g., ₹7,000 on ₹10,000 limit).
  - *Action*: Inform trader. Review open positions and risk exposure. Prepare for potential automatic circuit breaker lock if losses increase.
- **90% Loss Utilization (`RISK_WARNING_90`)**: Loss has reached 90% of Daily Loss Limit (e.g., ₹9,000 on ₹10,000 limit).
  - *Action*: Critical warning. Recommend reducing position sizing or voluntarily hedging open risk before circuit breaker lock triggers.

### Daily Loss Limit Breach (`LOSS_LIMIT_BREACHED` & `TRADING_LOCK_CREATED`)
- When gross loss reaches or exceeds 100% of Daily Loss Limit (e.g., ≥ ₹10,000):
  1. Authoritative Server Risk Engine immediately transitions session state to `LOCKED`.
  2. `lockedAt` timestamp is recorded and `lockUntil` is set to `lockedAt + 720 minutes` (or 4:00 PM IST based on configuration).
  3. `LOSS_LIMIT_BREACHED` and `TRADING_LOCK_CREATED` audit events are emitted and persisted to Firestore.
  4. Trading Firewall restricts account order execution.

---

## 3. Lock Lifecycle, Expiry, and Persistent Breach Behavior

### 720-Minute Lock Duration
- Once established, `lockedAt` and `lockUntil` are **immutable** and cannot be extended, shortened, or bypassed by modifying client risk configuration.

### Lock Expiration & Continuing Breach
- When `evaluationTime >= lockUntil`:
  - If loss has improved below Daily Loss Limit (< ₹10,000): Session state transitions to `ALLOW` or `WARNING`, emitting `TRADING_LOCK_EXPIRED`.
  - If loss remains **at or above** Daily Loss Limit (≥ ₹10,000):
    1. Lock expires (`TRADING_LOCK_EXPIRED` emitted).
    2. Engine detects persistent breach (`isNewlyBreached === true`).
    3. Re-locks immediately (`UNRESOLVED_BREACH_RELOCKED` & `TRADING_LOCK_CREATED` emitted).
    4. New `lockUntil` is calculated for another 720 minutes.

---

## 4. Reconnecting Safely and Verifying Fresh Data

### Reconnection Procedure
1. Obtain fresh broker authentication session via the authorized UI login flow (TOTP + credentials for Angel One; OAuth login for Zerodha).
2. Execute `GET /api/pnl` or `GET /api/angelone/positions` to verify live feed status.
3. Confirm connection event `BROKER_RECONNECTED` or `DATA_FEED_RECOVERED` appears in the Risk Activity Panel.
4. Verify `positions` array contains fresh non-stale LTP prices (`isStale: false`).

---

## 5. Authorized Operator Lock Reset Procedure

### Policy
- Lock resets are strictly restricted to authorized operators during emergency recovery or post-incident review.

### Execution
1. Send authenticated `POST /api/risk/evaluate` or `POST /api/risk/reset-lock` with:
   - Header: `Authorization: Bearer <verified_firebase_token>`
   - Header or Payload: `x-account-id: <account_id>`
   - Body: `{ reset: true, accountId: "<account_id>" }`
2. Server verifies caller token and permissions.
3. Baseline session is cleared and authoritative re-evaluation executes against fresh current positions.
4. An `AUTHORIZED_SESSION_RESET` event is recorded in the immutable audit trail with timestamp, operator user ID, and target account.

---

## 6. Verifying Cross-Account Isolation

To verify Angel One and Zerodha risk configurations, sessions, and locks remain 100% isolated:
1. Query Zerodha session: `GET /api/risk?accountId=acc_mt_zerodha_default`.
2. Query Angel One session: `GET /api/risk?accountId=acc_mt_angelone_default`.
3. Confirm:
   - A lock on `acc_mt_angelone_default` has `0` effect on `acc_mt_zerodha_default`.
   - Modifying Angel One risk config (`PUT /api/risk/config`) never mutates Zerodha limits or `executionMode`.
   - Angel One events do not leak into Zerodha event queries.

---

## 7. Monitoring or Event Persistence Failure Procedure

If Firestore persistence encounters an outage or `FIRESTORE_PERSISTENCE_FAILURE` error:
1. In-memory RAM cache in `ServerRiskStore` continues enforcing current risk state (`LOCKED` or `WARNING`) to guarantee fail-closed security.
2. An `error` severity event is logged to server stdout/stderr.
3. Once Firestore connectivity restores, `getAuditEvents` syncs in-memory events to persistent storage automatically.
4. **FAIL-CLOSED GUARANTEE**: Database errors must NEVER clear active locks or treat an account as healthy.

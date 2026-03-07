# Community-Powered Emergency Fund

A programmable, community-driven emergency fund platform built on Open Payments (Interledger). Members make recurring micro-contributions into a shared pool. When a verified disaster occurs, the platform automatically disburses funds to eligible members based on transparent, community-governed payout rules.

---

## How It Works

### The Full Flow

```
INBOUND (contributions)
Member wallet
  → Open Payments grant (recurring auth)
  → Incoming payment resource created on fund wallet
  → Backend confirms receipt
  → Contribution recorded in ClickHouse
  → Event logged to audit chain

OUTBOUND (payouts)
External disaster API (USGS / NWS)
  → Trigger engine detects qualifying signal
  → AI verification layer cross-checks (optional)
  → Rule engine calculates eligible members + amounts
  → Open Payments outgoing payment per recipient
  → Payout recorded in ClickHouse
  → Event logged to audit chain
```

### Architecture Layers

```
src/
├── server.ts                   Entry point — bootstraps all layers in order
├── config/index.ts             All environment config in one place
├── types/index.ts              Shared domain types (Member, Payout, Proposal, etc.)
│
├── db/
│   ├── clickhouse.ts           ClickHouse client + table definitions
│   ├── memberRegistry.ts       Member identity and consent operations
│   └── fundPool.ts             Derived balance (SUM contributions - SUM payouts)
│
├── services/
│   ├── payments.ts             Open Payments SDK wrapper (inbound + outbound)
│   ├── triggerEngine.ts        Polls USGS + NWS, detects disaster signals
│   ├── ruleEngine.ts           Distribution logic (equal split, severity-based, etc.)
│   ├── governanceModule.ts     Proposals, voting, tally, and rule application
│   ├── aiVerification.ts       Optional AI cross-check on disaster signals
│   └── eventLog.ts             Append-only hash-chained audit log
│
└── routes/
    ├── members.ts              POST /members, GET /members/:id
    ├── contributions.ts        POST /contributions/setup, /confirm, GET /contributions
    ├── governance.ts           POST /governance/proposals, GET, POST /vote
    ├── audit.ts                GET /audit/events, /root-hash, /verify, /payouts
    └── dashboard.ts            GET /dashboard/public, /member/:id, /signals
```

---

## Key Design Decisions

### Open Payments on both sides
The Open Payments SDK handles both inbound (member contributions) and outbound (disaster payouts). Contributions use recurring grants so members authorise once and payments happen automatically. Payouts use non-interactive grants signed by the fund's private key.

### ClickHouse as the database
ClickHouse is an append-only columnar database — a natural fit for this workload:
- Contributions and payouts are high-volume inserts, never updated in place
- Dashboard aggregations (`SUM`, `COUNT`, `GROUP BY`) are extremely fast
- The audit event log is immutable by design (MergeTree engine)
- Mutable entities (members, rules, proposals) use `ReplacingMergeTree` — "updates" are new rows and ClickHouse deduplicates on merge. Always use `FINAL` when reading these tables.

### Derived fund balance
There is no stored balance row. The current balance is always computed as:
```sql
SUM(contributions WHERE status = 'completed')
- SUM(payouts WHERE status = 'completed')
```
This is tamper-resistant — the balance is always consistent with the actual transaction history.

### Hash-chained audit log
Every state change writes an event to `audit_events`. Each event stores the hash of the previous event, forming a linked chain:

```
hash(n) = SHA-256(prevHash + type + payload + timestamp)
```

If any historical record is altered, the chain breaks and `GET /audit/verify` returns the offending event ID. The latest root hash can be published to IPFS periodically for external verification.

### Governance-driven rules
Payout rules are not hardcoded. Any member can propose a rule change (distribution method, severity threshold, eligibility radius, payout cap). Members vote within a 48-hour window. A simple majority passes the proposal, which is automatically applied to the rule engine.

---

## Getting Started

### Prerequisites
- Node.js 20+
- Docker (for ClickHouse)

### 1. Start ClickHouse
```bash
docker run -d \
  --name community-fund-db \
  -p 8123:8123 \
  -p 9000:9000 \
  clickhouse/clickhouse-server
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
```

Edit `.env` with your values. The minimum required fields:

| Variable | Description |
|---|---|
| `OP_WALLET_ADDRESS` | Your fund's Open Payments wallet address |
| `OP_PRIVATE_KEY_PATH` | Path to your private key file |
| `OP_KEY_ID` | Key ID registered in your wallet's JWKS |
| `JWT_SECRET` | Secret for member auth tokens |

Everything else has sensible defaults for local development.

### 4. Run the server
```bash
npm run dev
```

The server starts on port 3000, initialises ClickHouse tables, and begins polling for disaster signals every 5 minutes.

---

## API Reference

### Members
| Method | Path | Description |
|---|---|---|
| `POST` | `/members` | Register a member (consent required) |
| `GET` | `/members/:id` | Get member profile |

### Contributions (Inbound)
| Method | Path | Description |
|---|---|---|
| `POST` | `/contributions/setup` | Create incoming payment + optional recurring grant |
| `POST` | `/contributions/confirm` | Confirm payment received (webhook or manual) |
| `GET` | `/contributions?memberId=` | List a member's contributions |

### Governance
| Method | Path | Description |
|---|---|---|
| `POST` | `/governance/proposals` | Submit a rule/threshold proposal |
| `GET` | `/governance/proposals` | List open proposals with live vote counts |
| `GET` | `/governance/proposals/:id` | Get a single proposal |
| `POST` | `/governance/proposals/:id/vote` | Cast a vote |

### Audit (Public — no auth required)
| Method | Path | Description |
|---|---|---|
| `GET` | `/audit/events` | Paginated event log |
| `GET` | `/audit/events/:id` | Single event with chain proof data |
| `GET` | `/audit/root-hash` | Current chain root hash |
| `GET` | `/audit/verify` | Verify full chain integrity |
| `GET` | `/audit/payouts` | Anonymized public payout history |

### Dashboard
| Method | Path | Description |
|---|---|---|
| `GET` | `/dashboard/public` | Fund balance, totals, recent payouts |
| `GET` | `/dashboard/member/:id` | Member's contribution and payout history |
| `GET` | `/dashboard/signals` | Recent disaster signals |

---

## Disaster Trigger Sources

The trigger engine polls two sources by default:

**USGS Earthquake Hazards API** — detects earthquakes above M5.0. Severity is mapped directly from the Richter magnitude (capped at 10).

**National Weather Service API** — detects active Extreme and Severe weather alerts (hurricanes, floods, typhoons). Severity is mapped from the NWS severity classification.

New sources can be added in `src/services/triggerEngine.ts` by implementing an adapter function that returns `DisasterSignal[]`.

---

## AI Verification (Optional)

Set `AI_ENABLED=true` in `.env` to enable AI cross-checking of disaster signals before they reach the rule engine. The AI layer receives the signal type, severity, location, and raw API payload, and returns a confidence score with a verification note.

If the AI call fails, the signal is held (not auto-verified) to avoid false payouts. If AI is disabled, signals are auto-verified when their severity meets the active rule's threshold.

The default implementation calls an OpenAI-compatible endpoint. Swap the provider in `src/services/aiVerification.ts`.

---

## Payout Distribution Methods

Configured via governance proposals on the `distributionMethod` field:

| Method | Behaviour |
|---|---|
| `equal_split` | Fund balance divided equally among eligible members, capped per member |
| `severity_based` | Payout scales linearly with disaster severity (1–10) |
| `capped_payout` | Each eligible member receives exactly the cap amount |
| `household_size` | Proportional to household size (stub — requires schema extension) |

Eligibility is determined by the `eligibilityRadiusKm` field on the active rule. Members within that radius of the disaster location qualify for a payout.

---

## Transparency & Auditability

The platform is designed so that no trust in the operator is required:

1. Every payout is an Open Payments transaction — cryptographically signed and non-repudiable via the OP public key registry.
2. Every state change is recorded in the append-only `audit_events` table with a hash chain.
3. `GET /audit/verify` checks the full chain integrity on demand.
4. `GET /audit/root-hash` returns the latest chain root hash — publish this periodically to IPFS or a public endpoint to timestamp-stamp the fund's state.
5. All payout rules are defined and approved by community governance — no admin can unilaterally change the distribution logic.

# Community-Powered Emergency Fund

> **HackOMania 2026 — Interledger Foundation Challenge**
> Instant, transparent, community-governed disaster relief using Open Payments.

---

## Problem

When natural disasters strike, traditional emergency funds are **slow to distribute**, **dependent on manual approval**, and **lack transparency** in how money is allocated. Communities already pool resources informally — this project digitizes and automates that process using the Interledger Protocol.

## Solution

A full-stack platform where communities can:

1. **Pool contributions** via Interledger wallets (one-off or recurring)
2. **Define payout rules together** through on-platform governance voting
3. **Automatically detect disasters** from USGS Earthquake + NWS Weather APIs
4. **Instantly distribute funds** to affected members based on proximity, severity, and community-defined rules
5. **Audit every transaction** through a SHA-256 hash-chained event log

---

## Architecture

```
┌───────────────────────────────────────────────────┐
│                  Frontend (SPA)                   │
│  Guide · Overview · Contribute · Members          │
│  Governance · Disaster Signals · Audit · Map      │
└────────────────────────┬──────────────────────────┘
                         │ REST API
┌────────────────────────▼──────────────────────────┐
│            Fastify Backend (TypeScript)            │
│                                                   │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌───────────┐  │
│  │Payment │ │Trigger │ │  Rule  │ │Governance │  │
│  │Service │ │ Engine │ │ Engine │ │  Module   │  │
│  └───┬────┘ └───┬────┘ └───┬────┘ └─────┬─────┘  │
│      │          │          │             │        │
│  ┌───▼────┐ ┌───▼────┐ ┌──▼───────┐ ┌───▼─────┐  │
│  │Open Pay│ │USGS/NWS│ │ClickHouse│ │ Voting  │  │
│  │ (ILP)  │ │  APIs  │ │    DB    │ │ System  │  │
│  └────────┘ └────────┘ └──────────┘ └─────────┘  │
└───────────────────────────────────────────────────┘
```

---

## Features vs. Challenge Criteria

| Challenge Criterion | How We Address It |
|---|---|
| **Instant & Automatic Payouts** | Trigger engine polls USGS/NWS every 5 min → AI verifies signal → rule engine dispatches ILP payments to eligible members instantly |
| **Clear & Transparent Tracking** | Real-time dashboard with fund balance, contribution/payout history, Leaflet map visualization, and SHA-256 hash-chained audit log with tamper detection |
| **Fair & Clear Rules** | 5 distribution methods (equal split, severity-based, capped, proximity-weighted, household size). Community votes on rule changes via governance proposals |
| **Privacy & Respect** | Explicit consent required for registration. Anonymized payout reporting in audit log. Wallet-based identity (no email/phone required) |
| **Built to Grow** | Flexible contributions (one-off, daily, weekly, monthly). Multi-currency support. Extensible signal sources. Bulk seed tooling for testing |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | TypeScript, Fastify |
| Database | ClickHouse (MergeTree + ReplacingMergeTree) |
| Payments | Interledger Open Payments SDK |
| Disaster APIs | USGS Earthquake API, NWS Weather Alerts API |
| AI Verification | OpenAI GPT (optional, configurable) |
| Frontend | Vanilla HTML/CSS/JS, Leaflet.js for maps |
| DevOps | Docker (ClickHouse), ts-node-dev |

---

## Quick Start

### Prerequisites

- Node.js 18+
- Docker (for ClickHouse)
- An [Interledger test wallet](https://wallet.interledger-test.dev)

### 1. Clone & Install

```bash
git clone https://github.com/<your-org>/hackomania_interledger.git
cd hackomania_interledger/community-fund
npm install
```

### 2. Start ClickHouse

```bash
docker run -d --name community-fund-db -p 8123:8123 -p 9000:9000 clickhouse/clickhouse-server
docker exec community-fund-db clickhouse-client --query "CREATE DATABASE IF NOT EXISTS community_fund"
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Required variables:
```env
OP_WALLET_ADDRESS=https://ilp.interledger-test.dev/your-wallet
OP_PRIVATE_KEY_PATH=./private.key
OP_KEY_ID=your-key-id

CLICKHOUSE_HOST=http://localhost:8123
CLICKHOUSE_DB=community_fund
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=

SIMULATE_PAYOUTS=true   # Set false for real ILP transfers
```

### 4. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — the Guide tab walks you through donating or registering for aid.

### 5. Seed Test Members (Optional)

```bash
npm run seed              # 500 members, default region
npm run seed -- -c 100    # 100 members
npm run seed -- --clear   # wipe seeded members first
```

---

## How It Works

### Contribution Flow
1. Donor enters wallet address + amount on the **Contribute** tab
2. System creates an Open Payments incoming payment on the fund wallet
3. Donor is redirected to their wallet to approve the interactive grant
4. On approval, redirect back with confirmation → contribution recorded

### Disaster Detection & Payout
1. **Trigger Engine** polls USGS (earthquakes) and NWS (severe weather) every 5 minutes
2. New signals are stored with severity, location, and coordinates
3. Signals exceeding the community's severity threshold trigger the **Rule Engine**
4. Rule Engine finds members within the eligibility radius using ClickHouse `geoDistance()`
5. Payouts are calculated using the active distribution method:
   - `equal_split` — divide equally among eligible members
   - `severity_based` — scale payout by disaster severity (1-10)
   - `capped_payout` — fixed max per member
   - `proximity_weighted` — inverse-distance weighting (closer to disaster = more aid)
   - `household_size` — proportional to household
6. ILP outgoing payments are dispatched to each member's wallet
7. Every action is logged in the hash-chained audit trail

### Governance
1. Any registered member can propose rule changes (distribution method, payout cap, severity threshold, eligibility radius)
2. Members vote yes/no/abstain within a configurable window (default 48h)
3. Simple majority passes → rule automatically applied
4. All proposals and votes are visible on the **Governance** tab

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/dashboard/public` | Fund balance, member count, contribution/payout stats |
| GET | `/dashboard/signals` | Recent disaster signals with coordinates |
| GET | `/members` | All registered members |
| POST | `/members` | Register a new member |
| POST | `/contribute/start` | Initiate a contribution (redirects to wallet) |
| GET | `/contribute/finish` | Callback after wallet approval |
| GET | `/contributions` | All contributions |
| POST | `/governance/proposals` | Create a governance proposal |
| GET | `/governance/proposals` | List all proposals |
| POST | `/governance/proposals/:id/vote` | Cast a vote |
| GET | `/audit/events` | Full hash-chained audit log |
| GET | `/audit/verify` | Verify audit chain integrity |
| GET | `/audit/root-hash` | Latest chain root hash |

---

## Project Structure

```
community-fund/
├── public/index.html          # Single-page frontend
├── src/
│   ├── server.ts              # Fastify app + route registration
│   ├── config/index.ts        # Environment configuration
│   ├── db/
│   │   ├── clickhouse.ts      # ClickHouse client
│   │   ├── schema.ts          # Table creation (auto-migrate)
│   │   ├── fundPool.ts        # Fund balance queries
│   │   └── memberRegistry.ts  # Member CRUD + geo queries
│   ├── routes/
│   │   ├── contribute.ts      # Contribution flow (start/finish)
│   │   ├── members.ts         # Member registration
│   │   ├── dashboard.ts       # Public dashboard data
│   │   ├── governance.ts      # Proposals + voting
│   │   ├── audit.ts           # Audit log + verification
│   │   ├── admin.ts           # Payout auth management
│   │   └── test.ts            # Seed/test helpers
│   ├── services/
│   │   ├── payments.ts        # Open Payments ILP integration
│   │   ├── triggerEngine.ts   # USGS/NWS disaster polling
│   │   ├── ruleEngine.ts      # Payout calculation + distribution
│   │   ├── governanceModule.ts# Proposal voting + tally
│   │   ├── eventLog.ts        # SHA-256 hash-chained audit
│   │   ├── aiVerification.ts  # Optional AI signal verification
│   │   └── payoutAuth.ts      # ILP grant token management
│   └── types/index.ts         # TypeScript interfaces
└── scripts/
    └── seed-members.ts        # Bulk test member generator
```

---

## Demo Flow (Recommended)

1. **Guide Tab** — Show the onboarding experience
2. **Register 2-3 members** with test wallets on the Members tab
3. **Contribute funds** from a test wallet on the Contribute tab
4. **Overview Tab** — Show real-time balance, member map, disaster signals
5. **Governance Tab** — Create a rule proposal, vote on it
6. **Wait for a disaster signal** (or use `/test/seed-signal` to trigger one)
7. **Show automatic payout** in the Overview payouts table
8. **Audit Tab** — Verify chain integrity, show tamper-proof log

---

## Team

Built at HackOMania 2026 for the Interledger Foundation challenge.

## License

MIT
# Demo Script — Screen Recording & Canva Slides

> Target: ~5 min screen recording. Each section maps to a slide in Canva.
> Run everything from `http://localhost:3000` with the server already started.

---

## Pre-Demo Setup (Off-Camera)

```powershell
# 1. Start ClickHouse
docker start community-fund-db

# 2. Wipe old seed data (keeps manually registered members)
docker exec community-fund-db clickhouse-client --query "ALTER TABLE community_fund.members DELETE WHERE wallet_address LIKE '%/seed_%'"

# 3. Seed geographic clusters around disaster-prone cities
cd C:\Users\weife\hackomania_interledger\community-fund

# Singapore (flooding, urban density)
npm run seed -- --count 300 --lat 1.3521 --lng 103.8198 --spread 0.3

# Manila, Philippines (typhoons, flooding)
npm run seed -- --count 300 --lat 14.5995 --lng 120.9842 --spread 0.5

# Jakarta, Indonesia (flooding, earthquakes)
npm run seed -- --count 300 --lat -6.2088 --lng 106.8456 --spread 0.4

# Tokyo, Japan (earthquakes, tsunamis)
npm run seed -- --count 200 --lat 35.6762 --lng 139.6503 --spread 0.6

# Kathmandu, Nepal (earthquakes)
npm run seed -- --count 200 --lat 27.7172 --lng 85.3240 --spread 0.3

# 4. Start the server
npm run dev

# 5. Verify server is running
curl http://localhost:3000/health
```

Expected: `{ "status": "ok", ... }` and ~1300 seeded members across 5 clusters.

---

## Scene 1 — Guide Page (Slide: "Onboarding")

**What to show:** The landing page that greets new users.

1. Open `http://localhost:3000` in browser
2. The **Guide** tab is shown by default
3. Point out:
   - "I Want to Donate" card → links to Contribute tab
   - "I Need Emergency Aid" card → links to Members (registration) tab
   - "How It Works" 4-step flow: Join → Fund → Detect → Payout

**Talking point:** _"The platform guides both donors and recipients from the very first interaction."_

---

## Scene 2 — Register Members (Slide: "Easy to Join")

**What to show:** Low-friction member registration with consent.

1. Click **"I Need Emergency Aid"** button (or Members tab)
2. Register **Member 1**:
   - Name: `Alice Tan`
   - Email: `alice@example.com`
   - Wallet: `$ilp.interledger-test.dev/alice-tan`
   - Location: `Singapore`
   - Latitude: `1.3521`, Longitude: `103.8198`
   - Check "I consent"
   - Click **Register Member**
3. Register **Member 2**:
   - Name: `Bob Kumar`
   - Email: `bob@example.com`
   - Wallet: `$ilp.interledger-test.dev/bob-kumar`
   - Location: `Jakarta, Indonesia`
   - Latitude: `-6.2088`, Longitude: `106.8456`
   - Check "I consent"
   - Click **Register Member**
4. Show the member list updates in real-time below

**Talking point:** _"Members register with their Interledger wallet. Consent is explicit and required. The wallet address is auto-normalized from the friendly $ format."_

---

## Scene 3 — Contribute Funds (Slide: "Pool Money Together")

**What to show:** Making a real ILP contribution to the community fund.

1. Click **"I Want to Donate"** button (or Contribute tab)
2. Fill in:
   - Wallet Address: `$ilp.interledger-test.dev/your-test-wallet`
   - Amount: `10000` (point out the tooltip: "In smallest unit, e.g. cents")
   - Name: `Charlie Donor`
3. Click **Contribute via Open Payments**
4. You'll be redirected to the Interledger test wallet to approve
5. Approve the payment in the wallet UI
6. Redirected back → green success banner: _"Payment successful! You contributed 100.00 USD"_

**Talking point:** _"Contributions flow through the Interledger Protocol — no bank intermediaries, instant settlement, any currency."_

---

## Scene 4 — Overview Dashboard (Slide: "Real-Time Transparency")

**What to show:** Live fund health and map visualization with 1300+ members across Asia-Pacific.

1. Click the **Overview** tab
2. Point out the 4 stat cards:
   - **Fund Balance** — shows the contribution just made
   - **Total Members** — ~1300+ (seeded clusters + manually registered)
   - **Contributions** — count and total
   - **Payouts** — 0 so far
3. Scroll down to the **Member & Disaster Map**:
   - Purple dot clusters = members in Singapore, Manila, Jakarta, Tokyo, Kathmandu
   - Colored dots = live disaster signals from USGS/NWS
   - Point out the legend: High (red) / Medium (orange) / Low (green)
4. Zoom into a cluster (e.g. Singapore) to show Gaussian bell-curve distribution
5. Zoom out to show the full Asia-Pacific spread

**Talking point:** _"The dashboard shows real-time fund health. Over 1,300 members are clustered across 5 disaster-prone cities — the map plots every member alongside live earthquake and severe weather data from USGS and the National Weather Service. When a disaster strikes near a cluster, proximity-weighted payouts automatically prioritize the closest members."_

---

## Scene 5 — Governance Voting (Slide: "Community-Defined Rules")

**What to show:** Democratic rule-setting by members.

1. Click the **Governance** tab
2. Create a proposal:
   - Title: `Switch to proximity-weighted payouts`
   - Description: `Members closer to the disaster should receive more aid`
   - Type: `rule_change`
   - Proposed By: _(use a member ID from the member list)_
3. Click **Create Proposal**
4. The proposal appears in the list below
5. Cast a vote: click the proposal, vote **Yes**
6. Show vote counts updating

**Talking point:** _"Any member can propose rule changes. The community votes — simple majority wins. Passed rules automatically apply to future payouts."_

---

## Scene 6 — Automatic Disaster Payout (Slide: "Instant Payouts")

**What to show:** The trigger engine detecting a disaster and auto-paying members.

**Option A — Wait for real signal** (if USGS/NWS has a recent event):
- Show the **Disaster Signals** tab with detected signals
- If a signal ≥ severity 5 exists, payouts fire automatically

**Option B — Trigger manually via API** (reliable for demo):

```powershell
# Seed payout rule + trigger a simulated disaster
curl -X POST http://localhost:3000/test/seed-rule
curl -X POST http://localhost:3000/test/trigger-payout -H "Content-Type: application/json" -d "{\"type\": \"earthquake\", \"severity\": 7, \"location\": \"Singapore\"}"
```

Then in the browser:
1. Click **Overview** tab → show the Payouts stat card incremented
2. Scroll to **Recent Payouts** table → show payout entries with:
   - Amount, currency, disaster type, distribution method
3. Click **Disaster Signals** tab → show the signal that triggered it

**Talking point:** _"When a disaster is detected — either from live USGS/NWS data or a verified report — the rule engine automatically calculates and distributes payouts to affected members via ILP. No manual approval needed."_

---

## Scene 7 — Audit Trail (Slide: "Tamper-Proof Transparency")

**What to show:** Hash-chained audit log with verification.

1. Click the **Audit** tab
2. Show the event list:
   - Each event has a type (member_registered, contribution_recorded, payout_executed, etc.)
   - Events are timestamped and linked by SHA-256 hashes
3. Point out the **Chain Integrity** section:
   - Click **Verify Chain** → shows "Chain is valid" (green)
   - Show Root Hash — this can be published to IPFS for external verification

**Talking point:** _"Every action is logged in a SHA-256 hash chain. Tampering with any event breaks the chain. The root hash can be published externally for independent verification."_

---

## Scene 8 — Recap (Slide: "Challenge Criteria Met")

No screen recording needed — this is a Canva text slide.

| Criterion | Feature |
|---|---|
| Instant & Automatic Payouts | Trigger engine + Rule engine + ILP payments |
| Clear & Transparent Tracking | Real-time dashboard + Map + Hash-chained audit |
| Fair & Clear Rules | 5 distribution methods + Governance voting |
| Privacy & Respect | Consent-based registration + Anonymized audit |
| Built to Grow | Flexible contributions + Multi-currency + Extensible |

---

## API Quick Reference (For Live Terminal Demo, Optional)

```powershell
# Health check
curl http://localhost:3000/health

# View fund status
curl http://localhost:3000/dashboard/public

# List members
curl http://localhost:3000/members

# List disaster signals
curl http://localhost:3000/dashboard/signals

# View audit events
curl http://localhost:3000/audit/events

# Verify audit chain integrity
curl http://localhost:3000/audit/verify

# Get root hash
curl http://localhost:3000/audit/root-hash

# Seed a payout rule (for demo)
curl -X POST http://localhost:3000/test/seed-rule

# Trigger a test disaster payout
curl -X POST http://localhost:3000/test/trigger-payout -H "Content-Type: application/json" -d "{\"type\": \"earthquake\", \"severity\": 7, \"location\": \"Singapore\"}"

# Full automated flow (seed + fund + trigger + payout)
curl -X POST http://localhost:3000/test/full-flow
```

---

## Canva Slide Structure (Suggested)

1. **Title** — Community-Powered Emergency Fund
2. **Problem** — Traditional aid is slow, opaque, manual
3. **Solution** — Automated, transparent, community-governed fund on Interledger
4. **Architecture** — ASCII diagram from README (or recreate in Canva)
5. **Demo: Onboarding** — Screenshot of Guide tab
6. **Demo: Contribute** — Screenshot of contribution flow + wallet redirect
7. **Demo: Dashboard** — Screenshot of Overview with map
8. **Demo: Governance** — Screenshot of proposal + voting
9. **Demo: Auto-Payout** — Screenshot of payout triggered by disaster
10. **Demo: Audit** — Screenshot of hash chain + verification
11. **Challenge Criteria** — Mapping table
12. **Tech Stack** — TypeScript, Fastify, ClickHouse, Interledger, Leaflet
13. **Thank You / Q&A**

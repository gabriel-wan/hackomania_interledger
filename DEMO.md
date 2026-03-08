# Demo Script — Screen Recording & Canva Slides

> Target: ~5 min screen recording. Each section maps to a slide in Canva.
> Run everything from `http://localhost:3000` with the server already started.

---

## Pre-Demo Setup (Off-Camera)

### 0. Configure Interledger Test Wallet Credentials

You need **two types of wallets** on the Interledger test wallet:

- **Fund wallet** (the master wallet in `.env`) — this is the community fund that collects contributions and sends payouts. Set via `OP_WALLET_ADDRESS`.
- **Member wallet** (e.g. `tommywallet`) — a real wallet that seeded members point to, so payouts land in an actual account you can inspect.

#### Fund wallet setup:
1. Go to `https://wallet.interledger-test.dev` and create an account (or log in)
2. Create a wallet for the fund (e.g. `communityfund`) — this is the master wallet
3. Go to **Settings → Developer Keys** and create a new key pair:
   - Copy the **Key ID** (a UUID)
   - Download the **private key** file and save it as `community-fund/private.key`
4. Update `community-fund/.env`:

```dotenv
OP_WALLET_ADDRESS=https://ilp.interledger-test.dev/communityfund
OP_PRIVATE_KEY_PATH=./private.key
OP_KEY_ID=<paste your key ID here>
SIMULATE_PAYOUTS=false
```

#### Member wallet setup:
1. Create a separate wallet for receiving payouts (e.g. `tommywallet`)
2. All seeded members will use this wallet so you can see real money arriving
3. Pass `--wallet tommywallet` when seeding (see Step 1 below)

> **Note:** The wallet address in `.env` must use the `https://` format, not `$`.
> Alice and Bob (registered manually in Scene 2) should also use real wallets created at `https://wallet.interledger-test.dev`.

### 1. Start ClickHouse & Seed Members

```powershell
# Start ClickHouse
docker start community-fund-db

# Wipe old seed data (keeps manually registered members)
docker exec community-fund-db clickhouse-client --query "ALTER TABLE community_fund.members DELETE WHERE wallet_address LIKE '%/seed_%'"

# Wipe old payouts (clean slate)
docker exec community-fund-db clickhouse-client --query "ALTER TABLE community_fund.payouts DELETE WHERE 1=1"

# Seed geographic clusters around disaster-prone cities
cd C:\Users\weife\hackomania_interledger\community-fund

# Singapore (flooding, urban density)
npm run seed -- --count 300 --lat 1.3521 --lng 103.8198 --spread 0.3 --wallet tommywallet

# Manila, Philippines (typhoons, flooding)
npm run seed -- --count 300 --lat 14.5995 --lng 120.9842 --spread 0.5 --wallet tommywallet

# Jakarta, Indonesia (flooding, earthquakes)
npm run seed -- --count 300 --lat -6.2088 --lng 106.8456 --spread 0.4 --wallet tommywallet

# Tokyo, Japan (earthquakes, tsunamis)
npm run seed -- --count 200 --lat 35.6762 --lng 139.6503 --spread 0.6 --wallet tommywallet

# Kathmandu, Nepal (earthquakes)
npm run seed -- --count 200 --lat 27.7172 --lng 85.3240 --spread 0.3 --wallet tommywallet
```

### 2. Start the Server

```powershell
npm run dev
```

Verify: `Invoke-RestMethod http://localhost:3000/health` → `{ "status": "ok", ... }`

Expected: ~1300 seeded members across 5 clusters.

### 3. Authorize Real ILP Payouts (One-Time)

The Interledger test wallet requires browser-based consent before the fund can send outgoing payments. This step caches an access token so payouts transfer real money.

> **Important:** `.env` must have `SIMULATE_PAYOUTS=false` (already set).

1. Open in your **browser**: `http://localhost:3000/admin/payout-auth-url`
2. The page returns JSON with a `redirectUrl` — click that link
3. You are taken to `ilp.interledger-test.dev` — click **Approve** to grant the fund wallet permission to send outgoing payments
4. You are redirected back to `http://localhost:3000/?message=payout_authorized`
5. Verify in terminal:

```powershell
# Should show the cached token
Invoke-RestMethod http://localhost:3000/admin/payout-auth-status
```

6. (Optional) Persist the token so it survives server restarts:

```powershell
# Copy the returned token into .env as OP_PAYOUT_TOKEN=<token>
Invoke-RestMethod http://localhost:3000/admin/payout-token-value
```

### 4. Seed the Fund Balance

The fund needs money before payouts can distribute anything.

```powershell
# Add $1000.00 (100000 cents) to the fund pool
Invoke-RestMethod -Uri http://localhost:3000/test/seed-fund -Method POST
```

### 5. Seed a Payout Rule

```powershell
Invoke-RestMethod -Uri http://localhost:3000/test/seed-rule -Method POST
```

You are now ready to demo. The fund has money, a payout rule, and a live ILP authorization.

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

**What to show:** The trigger engine detecting a disaster and auto-paying members via real ILP transfers.

> **Pre-requisite:** You must have completed Pre-Demo Setup steps 3-5 (authorize payouts, seed fund, seed rule).

**Trigger the disaster** (run in PowerShell):

```powershell
Invoke-RestMethod -Uri http://localhost:3000/test/trigger-payout -Method POST -ContentType "application/json" -Body '{"type":"earthquake","severity":7,"location":"Singapore"}'
```

This sends real ILP outgoing payments from the fund wallet to each eligible member's wallet.

Then in the browser:
1. Click **Overview** tab → show the Payouts stat card incremented
2. Scroll to **Recent Payouts** table → show payout entries with:
   - Amount (real SGD), disaster type, distribution method
3. Click **Disaster Signals** tab → show the signal that triggered it
4. (Optional) Open the fund wallet at `https://wallet.interledger-test.dev` → show the actual money deductions in the transaction history

**Talking point:** _"When a disaster is detected — either from live USGS/NWS data or a verified report — the rule engine automatically calculates and distributes payouts to affected members via the Interledger Protocol. These are real money transfers, not simulations — you can see the deductions in the test wallet's transaction history. No manual approval needed."_

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
Invoke-RestMethod http://localhost:3000/health

# View fund status
Invoke-RestMethod http://localhost:3000/dashboard/public

# List members
Invoke-RestMethod http://localhost:3000/members

# List disaster signals
Invoke-RestMethod http://localhost:3000/dashboard/signals

# View audit events
Invoke-RestMethod http://localhost:3000/audit/events

# Verify audit chain integrity
Invoke-RestMethod http://localhost:3000/audit/verify

# Get root hash
Invoke-RestMethod http://localhost:3000/audit/root-hash

# Seed a payout rule (for demo)
Invoke-RestMethod -Uri http://localhost:3000/test/seed-rule -Method POST

# Trigger a test disaster payout
Invoke-RestMethod -Uri http://localhost:3000/test/trigger-payout -Method POST -ContentType "application/json" -Body '{"type":"earthquake","severity":7,"location":"Singapore"}'

# Full automated flow (seed + fund + trigger + payout)
Invoke-RestMethod -Uri http://localhost:3000/test/full-flow -Method POST
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

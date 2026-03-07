/**
 * Rule Engine
 * Applies the active payout rule to a verified disaster signal.
 * Determines which members are eligible and how much each receives.
 *
 * Distribution methods:
 *   equal_split      - Fund balance divided equally among eligible members
 *   severity_based   - Payout amount scales with disaster severity score
 *   household_size   - Proportional to member's registered household size (TODO: add to member schema)
 *   capped_payout    - Fixed amount per member up to configured cap
 */

import { randomUUID } from "crypto";
import { ch } from "../db/clickhouse";
import { DisasterSignal, Member, Payout, PayoutRule } from "../types";
import { getMembersInRadius } from "../db/memberRegistry";
import { debitFund, getBalance } from "../db/fundPool";
import {
  requestPayoutGrant,
  executeOutgoingPayment,
  createIncomingPaymentOnWallet,
} from "./payments";
import { logEvent } from "./eventLog";
import { config } from "../config";
import { getPayoutToken } from "./payoutAuth";

// ---------------------------------------------------------------------------
// Rule retrieval
// ---------------------------------------------------------------------------

export async function getActiveRule(): Promise<PayoutRule | null> {
  const result = await ch.query({
    query: "SELECT * FROM payout_rules FINAL WHERE active = 1 LIMIT 1",
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows[0] ? mapRuleRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Core distribution logic
// ---------------------------------------------------------------------------

/**
 * Entry point called by the trigger engine when a verified signal arrives.
 * Loads the active rule, resolves eligible members, calculates amounts,
 * and dispatches Open Payments outgoing payments.
 */
export type RuleEngineResult = {
  skipped?: string;
  eligibleMembers?: number;
  payouts: Array<{ memberId: string; amount: number; status: "ok" | "failed"; error?: string }>;
};

export async function runRuleEngine(signal: DisasterSignal): Promise<RuleEngineResult> {
  console.log(`[RuleEngine] Processing signal: ${signal.id}`);

  const rule = await getActiveRule();
  if (!rule) {
    console.warn("[RuleEngine] No active payout rule configured. Skipping.");
    return { skipped: "No active payout rule", payouts: [] };
  }

  if (signal.severity < rule.minSeverityThreshold) {
    console.log(`[RuleEngine] Signal severity ${signal.severity} below threshold ${rule.minSeverityThreshold}. Skipping.`);
    return { skipped: `Severity ${signal.severity} < threshold ${rule.minSeverityThreshold}`, payouts: [] };
  }

  const eligibleMembers = await getMembersInRadius(signal.latitude, signal.longitude, rule.eligibilityRadiusKm);
  if (eligibleMembers.length === 0) {
    console.log("[RuleEngine] No eligible members in affected area.");
    return { skipped: "No eligible members", payouts: [] };
  }

  const pool = await getBalance();
  const payoutAmounts = calculatePayouts(
    rule,
    pool.totalBalance,
    eligibleMembers,
    signal
  );

  await logEvent({
    type: "payout_triggered",
    payload: {
      signalId: signal.id,
      ruleId: rule.id,
      eligibleCount: eligibleMembers.length,
      totalPayout: payoutAmounts.total,
    },
    opTxId: null,
  });

  const results: RuleEngineResult["payouts"] = [];

  if (config.simulatePayouts) {
    console.log("[RuleEngine] SIMULATE_PAYOUTS=true — skipping real ILP transfers, recording payouts in DB only.");
  }

  // Dispatch individual payouts
  for (let i = 0; i < eligibleMembers.length; i++) {
    const member = eligibleMembers[i];
    const amount = payoutAmounts.perMember[i];

    // Skip members with no valid wallet address
    if (!member.walletAddress || !member.walletAddress.startsWith("http")) {
      console.warn(`[RuleEngine] Skipping member ${member.id}: invalid wallet address "${member.walletAddress}"`);
      results.push({ memberId: member.id, amount, status: "failed", error: "Invalid wallet address" });
      continue;
    }

    try {
      await dispatchPayout({
        signal,
        rule,
        memberId: member.id,
        memberWalletAddress: member.walletAddress,
        amount,
        currency: pool.currency,
      });
      results.push({ memberId: member.id, amount, status: "ok" });
    } catch (err: any) {
      const errMsg = err?.description ?? err?.message ?? String(err);
      console.error(`[RuleEngine] Payout failed for member ${member.id}:`, errMsg, err?.validationErrors);
      results.push({ memberId: member.id, amount, status: "failed", error: errMsg });
    }
  }

  return { eligibleMembers: eligibleMembers.length, payouts: results };
}

function calculatePayouts(
  rule: PayoutRule,
  totalBalance: number,
  members: Member[],
  signal: DisasterSignal
): { perMember: number[]; total: number } {
  const cap = rule.maxPayoutPerMember;
  const memberCount = members.length;
  let amounts: number[] = [];

  switch (rule.distributionMethod) {
    case "equal_split": {
      const perMember = Math.min(Math.floor(totalBalance / memberCount), cap);
      amounts = Array(memberCount).fill(perMember);
      break;
    }
    case "severity_based": {
      // Scale payout linearly with severity (1-10)
      const factor = signal.severity / 10;
      const perMember = Math.min(Math.floor((totalBalance / memberCount) * factor), cap);
      amounts = Array(memberCount).fill(perMember);
      break;
    }
    case "capped_payout": {
      // Each member gets exactly the cap, or their share if insufficient funds
      const perMember = Math.min(cap, Math.floor(totalBalance / memberCount));
      amounts = Array(memberCount).fill(perMember);
      break;
    }
    case "proximity_weighted": {
      // Inverse-distance weighting: members closer to epicenter get more
      const distances = members.map((m) => {
        const d = geoDistanceKm(signal.latitude, signal.longitude, m.latitude, m.longitude);
        return Math.max(d, 0.1); // floor at 100m to avoid division by zero
      });
      const weights = distances.map((d) => 1 / d);
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);

      amounts = weights.map((w) => {
        const share = Math.floor((w / totalWeight) * totalBalance);
        return Math.min(share, cap);
      });
      break;
    }
    case "household_size": {
      // TODO: Implement once household_size is added to member schema.
      // Falls back to equal split for now.
      const perMember = Math.min(Math.floor(totalBalance / memberCount), cap);
      amounts = Array(memberCount).fill(perMember);
      break;
    }
    default:
      throw new Error(`Unknown distribution method: ${rule.distributionMethod}`);
  }

  return {
    perMember: amounts,
    total: amounts.reduce((sum, a) => sum + a, 0),
  };
}

/** Haversine distance in km between two lat/lng points */
function geoDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function dispatchPayout(params: {
  signal: DisasterSignal;
  rule: PayoutRule;
  memberId: string;
  memberWalletAddress: string;
  amount: number;
  currency: string;
}): Promise<void> {
  const payoutId = randomUUID();

  // Determine the access token to use for the outgoing payment
  // Priority: pre-authorized cached token (from /admin/payout-auth-url flow)
  //           → fallback to per-payout grant request (may fail on test wallet)
  const cachedToken = getPayoutToken();
  let accessToken: string;
  let outgoingPaymentId: string;

  if (config.simulatePayouts) {
    // Simulation mode: skip real ILP transfer, just record the payout
    console.log(`[RuleEngine] SIMULATE: payout of ${params.amount} to ${params.memberWalletAddress}`);
    outgoingPaymentId = "simulated-" + randomUUID();
  } else {
    // Step 1: Create incoming payment on recipient's wallet
    const { incomingPaymentId } = await createIncomingPaymentOnWallet({
      recipientWalletAddress: params.memberWalletAddress,
      amount: params.amount,
    });

    // Step 2: Get an access token
    if (cachedToken) {
      // Use the pre-authorized token (cached after admin approves /admin/payout-auth-url)
      accessToken = cachedToken;
      console.log(`[RuleEngine] Using pre-authorized payout token for member ${params.memberId}`);
    } else {
      // Fall back to requesting a new grant per payout (will fail on test wallet without pre-auth)
      console.warn("[RuleEngine] No pre-authorized payout token. Visit /admin/payout-auth-url to authorize payouts.");
      const grant = await requestPayoutGrant({
        recipientWalletAddress: params.memberWalletAddress,
        amount: params.amount,
        currency: params.currency,
      });
      accessToken = grant.accessToken;
    }

    // Step 3: Execute the outgoing payment (creates quote then outgoing payment)
    const result = await executeOutgoingPayment({
      recipientWalletAddress: params.memberWalletAddress,
      incomingPaymentId,
      amount: params.amount,
      currency: params.currency,
      accessToken,
      metadata: {
        disasterSignalId: params.signal.id,
        ruleId: params.rule.id,
        payoutId,
      },
    });
    outgoingPaymentId = result.outgoingPaymentId;
  }

  // Step 4: Debit the fund pool
  await debitFund(params.amount);

  // Step 5: Persist payout record
  const payout: Payout = {
    id: payoutId,
    disasterSignalId: params.signal.id,
    memberId: params.memberId,
    amount: params.amount,
    currency: params.currency,
    ruleId: params.rule.id,
    opOutgoingPaymentId: outgoingPaymentId,
    status: "completed",
    createdAt: new Date().toISOString().replace("Z", ""),
  };

  await ch.insert({
    table: "payouts",
    values: [{
      id: payout.id,
      disaster_signal_id: payout.disasterSignalId,
      member_id: payout.memberId,
      amount: payout.amount,
      currency: payout.currency,
      rule_id: payout.ruleId,
      op_outgoing_payment_id: payout.opOutgoingPaymentId,
      status: payout.status,
      created_at: payout.createdAt,
    }],
    format: "JSONEachRow",
  });

  await logEvent({
    type: "payout_completed",
    payload: { payoutId, memberId: params.memberId, amount: params.amount },
    opTxId: outgoingPaymentId,
  });
}

function mapRuleRow(row: any): PayoutRule {
  return {
    id: row.id,
    name: row.name,
    distributionMethod: row.distribution_method,
    maxPayoutPerMember: row.max_payout_per_member,
    eligibilityRadiusKm: row.eligibility_radius_km,
    minSeverityThreshold: row.min_severity_threshold,
    proposedBy: row.proposed_by,
    approvedAt: row.approved_at,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

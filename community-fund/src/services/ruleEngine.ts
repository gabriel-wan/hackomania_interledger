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
import { DisasterSignal, Payout, PayoutRule } from "../types";
import { getMembersInRadius } from "../db/memberRegistry";
import { debitFund, getBalance } from "../db/fundPool";
import {
  requestPayoutGrant,
  executeOutgoingPayment,
  createIncomingPayment,
} from "./payments";
import { logEvent } from "./eventLog";

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
export async function runRuleEngine(signal: DisasterSignal): Promise<void> {
  console.log(`[RuleEngine] Processing signal: ${signal.id}`);

  const rule = await getActiveRule();
  if (!rule) {
    console.warn("[RuleEngine] No active payout rule configured. Skipping.");
    return;
  }

  if (signal.severity < rule.minSeverityThreshold) {
    console.log(`[RuleEngine] Signal severity ${signal.severity} below threshold ${rule.minSeverityThreshold}. Skipping.`);
    return;
  }

  const eligibleMembers = await getMembersInRadius(signal.location, rule.eligibilityRadiusKm);
  if (eligibleMembers.length === 0) {
    console.log("[RuleEngine] No eligible members in affected area.");
    return;
  }

  const pool = await getBalance();
  const payoutAmounts = calculatePayouts(
    rule,
    pool.totalBalance,
    eligibleMembers.length,
    signal.severity
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

  // Dispatch individual payouts
  for (let i = 0; i < eligibleMembers.length; i++) {
    const member = eligibleMembers[i];
    const amount = payoutAmounts.perMember[i];

    try {
      await dispatchPayout({
        signal,
        rule,
        memberId: member.id,
        memberWalletAddress: member.walletAddress,
        amount,
        currency: pool.currency,
      });
    } catch (err) {
      console.error(`[RuleEngine] Payout failed for member ${member.id}:`, err);
    }
  }
}

function calculatePayouts(
  rule: PayoutRule,
  totalBalance: number,
  memberCount: number,
  severity: number
): { perMember: number[]; total: number } {
  const cap = rule.maxPayoutPerMember;
  let amounts: number[] = [];

  switch (rule.distributionMethod) {
    case "equal_split": {
      const perMember = Math.min(Math.floor(totalBalance / memberCount), cap);
      amounts = Array(memberCount).fill(perMember);
      break;
    }
    case "severity_based": {
      // Scale payout linearly with severity (1-10)
      const factor = severity / 10;
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

async function dispatchPayout(params: {
  signal: DisasterSignal;
  rule: PayoutRule;
  memberId: string;
  memberWalletAddress: string;
  amount: number;
  currency: string;
}): Promise<void> {
  const payoutId = randomUUID();

  // Step 1: Create incoming payment on recipient's wallet
  const { incomingPaymentId } = await createIncomingPayment({
    amount: params.amount,
    currency: params.currency,
    memberId: params.memberId,
  });

  // Step 2: Request grant from fund wallet to send
  const { accessToken } = await requestPayoutGrant({
    recipientWalletAddress: params.memberWalletAddress,
    amount: params.amount,
    currency: params.currency,
  });

  // Step 3: Execute the outgoing payment
  const { outgoingPaymentId } = await executeOutgoingPayment({
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
    createdAt: new Date().toISOString(),
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

/**
 * Governance Module
 * Manages community voting on fund rules, payout thresholds,
 * and trigger definitions.
 *
 * Flow:
 *   1. Any member proposes a change
 *   2. Members vote within the proposal's expiry window
 *   3. On expiry, the proposal is tallied — simple majority passes
 *   4. Passed rule proposals are applied to payout_rules automatically
 */

import { randomUUID } from "crypto";
import { ch } from "../db/clickhouse";
import { Proposal, Vote, VoteChoice, ProposalType, PayoutRule } from "../types";
import { logEvent } from "./eventLog";

export async function createProposal(params: {
  type: ProposalType;
  title: string;
  description: string;
  proposedBy: string;
  payload: object;
  expiresInHours?: number;
}): Promise<Proposal> {
  const proposal: Proposal = {
    id: randomUUID(),
    type: params.type,
    title: params.title,
    description: params.description,
    proposedBy: params.proposedBy,
    payload: JSON.stringify(params.payload),
    votesYes: 0,
    votesNo: 0,
    votesAbstain: 0,
    status: "open",
    expiresAt: new Date(Date.now() + (params.expiresInHours ?? 48) * 60 * 60 * 1000).toISOString().replace("Z", ""),
    createdAt: new Date().toISOString().replace("Z", ""),
  };

  await ch.insert({
    table: "proposals",
    values: [{
      id: proposal.id,
      type: proposal.type,
      title: proposal.title,
      description: proposal.description,
      proposed_by: proposal.proposedBy,
      payload: proposal.payload,
      votes_yes: 0,
      votes_no: 0,
      votes_abstain: 0,
      status: proposal.status,
      expires_at: proposal.expiresAt,
      created_at: proposal.createdAt,
    }],
    format: "JSONEachRow",
  });

  await logEvent({
    type: "rule_proposed",
    payload: { proposalId: proposal.id, type: proposal.type, title: proposal.title },
    opTxId: null,
  });

  return proposal;
}

export async function getOpenProposals(): Promise<Proposal[]> {
  const result = await ch.query({
    query: `
      SELECT
        p.id, p.type, p.title, p.description, p.proposed_by,
        p.payload, p.status, p.expires_at, p.created_at,
        countIf(v.choice = 'yes') AS votes_yes,
        countIf(v.choice = 'no') AS votes_no,
        countIf(v.choice = 'abstain') AS votes_abstain
      FROM proposals AS p FINAL
      LEFT JOIN votes AS v ON v.proposal_id = p.id
      WHERE p.status = 'open'
      GROUP BY p.id, p.type, p.title, p.description, p.proposed_by,
               p.payload, p.status, p.expires_at, p.created_at
    `,
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows.map(mapProposalRow);
}

export async function getProposalById(id: string): Promise<Proposal | null> {
  const result = await ch.query({
    query: `
      SELECT
        p.id, p.type, p.title, p.description, p.proposed_by,
        p.payload, p.status, p.expires_at, p.created_at,
        countIf(v.choice = 'yes') AS votes_yes,
        countIf(v.choice = 'no') AS votes_no,
        countIf(v.choice = 'abstain') AS votes_abstain
      FROM proposals AS p FINAL
      LEFT JOIN votes AS v ON v.proposal_id = p.id
      WHERE p.id = {id:String}
      GROUP BY p.id, p.type, p.title, p.description, p.proposed_by,
               p.payload, p.status, p.expires_at, p.created_at
    `,
    query_params: { id },
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows[0] ? mapProposalRow(rows[0]) : null;
}

export async function castVote(params: {
  proposalId: string;
  memberId: string;
  choice: VoteChoice;
}): Promise<Vote> {
  const proposal = await getProposalById(params.proposalId);
  if (!proposal) throw new Error("Proposal not found.");
  if (proposal.status !== "open") throw new Error("Proposal is no longer open for voting.");
  if (new Date() > new Date(proposal.expiresAt)) throw new Error("Proposal has expired.");

  const vote: Vote = {
    id: randomUUID(),
    proposalId: params.proposalId,
    memberId: params.memberId,
    choice: params.choice,
    createdAt: new Date().toISOString().replace("Z", ""),
  };

  await ch.insert({
    table: "votes",
    values: [{
      id: vote.id,
      proposal_id: vote.proposalId,
      member_id: vote.memberId,
      choice: vote.choice,
      created_at: vote.createdAt,
    }],
    format: "JSONEachRow",
  });

  await logEvent({
    type: "vote_cast",
    payload: { proposalId: params.proposalId, memberId: params.memberId, choice: params.choice },
    opTxId: null,
  });

  return vote;
}

export async function tallyExpiredProposals(): Promise<void> {
  const result = await ch.query({
    query: `
      SELECT
        p.id, p.type, p.title, p.description, p.proposed_by,
        p.payload, p.status, p.expires_at, p.created_at,
        countIf(v.choice = 'yes') AS votes_yes,
        countIf(v.choice = 'no') AS votes_no,
        countIf(v.choice = 'abstain') AS votes_abstain
      FROM proposals AS p FINAL
      LEFT JOIN votes AS v ON v.proposal_id = p.id
      WHERE p.status = 'open' AND p.expires_at <= toDateTime64({now:String}, 3, 'UTC')
      GROUP BY p.id, p.type, p.title, p.description, p.proposed_by,
               p.payload, p.status, p.expires_at, p.created_at
    `,
    query_params: { now: new Date().toISOString().replace("Z", "") },
    format: "JSONEachRow",
  });

  const expired = await result.json<any>();

  for (const row of expired) {
    const proposal = mapProposalRow(row);
    const totalVotes = proposal.votesYes + proposal.votesNo + proposal.votesAbstain;
    const passed = totalVotes > 0 && proposal.votesYes > proposal.votesNo;
    const newStatus = passed ? "passed" : "rejected";

    // Insert updated row — ReplacingMergeTree will deduplicate on merge
    await ch.insert({
      table: "proposals",
      values: [{
        id: proposal.id,
        type: proposal.type,
        title: proposal.title,
        description: proposal.description,
        proposed_by: proposal.proposedBy,
        payload: proposal.payload,
        votes_yes: proposal.votesYes,
        votes_no: proposal.votesNo,
        votes_abstain: proposal.votesAbstain,
        status: newStatus,
        expires_at: proposal.expiresAt,
        created_at: new Date().toISOString().replace("Z", ""), // newer timestamp = wins in ReplacingMergeTree
      }],
      format: "JSONEachRow",
    });

    if (passed) {
      await applyPassedProposal(proposal);
    }

    console.log(`[Governance] Proposal ${proposal.id} ${newStatus}.`);
  }
}

async function applyPassedProposal(proposal: Proposal): Promise<void> {
  if (proposal.type !== "rule_change") return;

  const payload = JSON.parse(proposal.payload) as Partial<PayoutRule>;

  // Deactivate existing rules by inserting updated rows
  const existingResult = await ch.query({
    query: "SELECT * FROM payout_rules FINAL WHERE active = 1",
    format: "JSONEachRow",
  });
  const existingRules = await existingResult.json<any>();

  for (const rule of existingRules) {
    await ch.insert({
      table: "payout_rules",
      values: [{ ...rule, active: 0, created_at: new Date().toISOString().replace("Z", "") }],
      format: "JSONEachRow",
    });
  }

  // Insert new active rule
  await ch.insert({
    table: "payout_rules",
    values: [{
      id: randomUUID(),
      name: payload.name ?? "Community Rule",
      distribution_method: payload.distributionMethod ?? "equal_split",
      max_payout_per_member: payload.maxPayoutPerMember ?? 10000,
      eligibility_radius_km: payload.eligibilityRadiusKm ?? 100,
      min_severity_threshold: payload.minSeverityThreshold ?? 5,
      proposed_by: proposal.proposedBy,
      approved_at: new Date().toISOString().replace("Z", ""),
      active: 1,
      created_at: new Date().toISOString().replace("Z", ""),
    }],
    format: "JSONEachRow",
  });

  await logEvent({
    type: "rule_approved",
    payload: { proposalId: proposal.id },
    opTxId: null,
  });
}

function mapProposalRow(row: any): Proposal {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    proposedBy: row.proposed_by,
    payload: row.payload,
    votesYes: Number(row.votes_yes ?? 0),
    votesNo: Number(row.votes_no ?? 0),
    votesAbstain: Number(row.votes_abstain ?? 0),
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
/**
 * Contributions Routes (Inbound Flow)
 * Handles member contribution setup — both one-off and recurring.
 *
 * POST /contributions/setup    - Create an incoming payment + recurring grant
 * POST /contributions/confirm  - Confirm a completed contribution
 * GET  /contributions          - List contributions (member-scoped)
 */

import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { createIncomingPayment, requestRecurringContributionGrant } from "../services/payments";
import { getMemberById } from "../db/memberRegistry";
import { logEvent } from "../services/eventLog";
import { ch } from "../db/clickhouse";
import { ApiResponse, Contribution } from "../types";

export async function contributionRoutes(app: FastifyInstance): Promise<void> {

  /**
   * Set up a contribution for a member.
   * Returns an Open Payments grant redirect URL for recurring contributions,
   * or an incoming payment URL for one-off contributions.
   */
  app.post<{
    Body: { memberId: string; amount: number; currency: string; frequency: string };
  }>("/contributions/setup", async (req, reply) => {
    const { memberId, amount, currency, frequency } = req.body;

    const member = await getMemberById(memberId);
    if (!member) {
      return reply.status(404).send({ success: false, error: "Member not found." });
    }
    if (!member.consentGiven) {
      return reply.status(403).send({ success: false, error: "Member consent required." });
    }

    const { incomingPaymentId, paymentUrl } = await createIncomingPayment({
      amount,
      currency,
      memberId,
    });

    let grantRedirectUrl: string | null = null;

    if (frequency !== "one-off") {
      const intervalSeconds = frequencyToSeconds(frequency);
      const grant = await requestRecurringContributionGrant({
        memberWalletAddress: member.walletAddress,
        amount,
        currency,
        intervalSeconds,
      });
      grantRedirectUrl = grant.continueUri;
    }

    const contribution: Contribution = {
      id: randomUUID(),
      memberId,
      amount,
      currency,
      frequency: frequency as any,
      opGrantId: "",
      opIncomingPaymentId: incomingPaymentId,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    await ch.insert({
      table: "contributions",
      values: [{
        id: contribution.id,
        member_id: contribution.memberId,
        amount: contribution.amount,
        currency: contribution.currency,
        frequency: contribution.frequency,
        op_grant_id: contribution.opGrantId,
        op_incoming_payment_id: contribution.opIncomingPaymentId,
        status: contribution.status,
        created_at: contribution.createdAt,
      }],
      format: "JSONEachRow",
    });

    const response: ApiResponse<{ contributionId: string; paymentUrl: string; grantRedirectUrl: string | null }> = {
      success: true,
      data: { contributionId: contribution.id, paymentUrl, grantRedirectUrl },
    };

    return reply.send(response);
  });

  /**
   * Confirm that a contribution payment was received.
   * Called by the Open Payments webhook or manually after payment completes.
   */
  app.post<{
    Body: { contributionId: string; opIncomingPaymentId: string };
  }>("/contributions/confirm", async (req, reply) => {
    const { contributionId, opIncomingPaymentId } = req.body;

    await ch.exec({
      query: "ALTER TABLE contributions UPDATE status = 'completed' WHERE id = {id:String} AND op_incoming_payment_id = {opId:String}",
      query_params: { id: contributionId, opId: opIncomingPaymentId },
    });

    const result = await ch.query({
      query: "SELECT * FROM contributions WHERE id = {id:String} LIMIT 1",
      query_params: { id: contributionId },
      format: "JSONEachRow",
    });
    const rows = await result.json<any>();
    const row = rows[0];

    if (!row) {
      return reply.status(404).send({ success: false, error: "Contribution not found." });
    }

    await logEvent({
      type: "contribution_received",
      payload: { contributionId, memberId: row.member_id, amount: row.amount },
      opTxId: opIncomingPaymentId,
    });

    return reply.send({ success: true, data: { contributionId, status: "completed" } });
  });

  /**
   * List contributions for a member.
   */
  app.get<{ Querystring: { memberId: string } }>(
    "/contributions",
    async (req, reply) => {
      const { memberId } = req.query;
      const result = await ch.query({
        query: "SELECT * FROM contributions WHERE member_id = {memberId:String} ORDER BY created_at DESC",
        query_params: { memberId },
        format: "JSONEachRow",
      });
      const rows = await result.json<any>();

      return reply.send({ success: true, data: rows });
    }
  );
}

function frequencyToSeconds(frequency: string): number {
  const map: Record<string, number> = {
    daily: 86400,
    weekly: 604800,
    monthly: 2592000,
  };
  return map[frequency] ?? 86400;
}

/**
 * Test Routes (development only)
 * Provides shortcuts to seed data and trigger the payout flow
 * without waiting for real disaster signals or proposal expiry.
 *
 * POST /test/seed-rule       - Insert an active payout rule directly (skip governance)
 * POST /test/seed-fund       - Add fake contribution to give the fund a balance
 * POST /test/trigger-payout  - Fire a fake disaster signal through the rule engine
 * POST /test/full-flow       - Do all of the above in one call
 */

import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { ch } from "../db/clickhouse";
import { runRuleEngine, getActiveRule } from "../services/ruleEngine";
import { logEvent } from "../services/eventLog";
import { DisasterSignal } from "../types";

export async function testRoutes(app: FastifyInstance): Promise<void> {

  /** Seed an active payout rule (bypasses governance voting) */
  app.post("/test/seed-rule", async (_req, reply) => {
    const existing = await getActiveRule();
    if (existing) {
      return reply.send({ success: true, message: "Rule already exists", data: existing });
    }

    const now = new Date().toISOString().replace("Z", "");
    await ch.insert({
      table: "payout_rules",
      values: [{
        id: randomUUID(),
        name: "Test Rule",
        distribution_method: "equal_split",
        max_payout_per_member: 10000,
        eligibility_radius_km: 500,
        min_severity_threshold: 3,
        proposed_by: "test-seed",
        approved_at: now,
        active: 1,
        created_at: now,
      }],
      format: "JSONEachRow",
    });

    const rule = await getActiveRule();
    return reply.send({ success: true, message: "Payout rule seeded", data: rule });
  });

  /** Add a fake completed contribution to give the fund a balance */
  app.post<{ Body: { amount?: number } }>("/test/seed-fund", async (req, reply) => {
    const amount = req.body?.amount ?? 100000; // default $1000.00 (in cents)
    const now = new Date().toISOString().replace("Z", "");

    await ch.insert({
      table: "contributions",
      values: [{
        id: randomUUID(),
        member_id: "test-seed",
        amount,
        currency: "USD",
        frequency: "one-off",
        op_grant_id: "",
        op_incoming_payment_id: "test-" + randomUUID(),
        status: "completed",
        created_at: now,
      }],
      format: "JSONEachRow",
    });

    await logEvent({
      type: "contribution_received",
      payload: { amount, source: "test-seed" },
      opTxId: null,
    });

    return reply.send({ success: true, message: `Fund credited with ${amount}` });
  });

  /** Fire a fake disaster signal through the rule engine */
  app.post<{
    Body: {
      type?: string;
      severity?: number;
      location?: string;
    };
  }>("/test/trigger-payout", async (req, reply) => {
    const signal: DisasterSignal = {
      id: randomUUID(),
      type: (req.body?.type ?? "earthquake") as any,
      severity: req.body?.severity ?? 7,
      location: req.body?.location ?? "Test Location",
      sourceApi: "test",
      sourceUrl: "",
      rawPayload: "{}",
      verified: true,
      verificationNote: "Test signal",
      detectedAt: new Date().toISOString().replace("Z", ""),
    };

    // Persist the test signal
    await ch.insert({
      table: "disaster_signals",
      values: [{
        id: signal.id,
        type: signal.type,
        severity: signal.severity,
        location: signal.location,
        source_api: signal.sourceApi,
        source_url: signal.sourceUrl,
        raw_payload: signal.rawPayload,
        verified: 1,
        verification_note: signal.verificationNote,
        detected_at: signal.detectedAt,
      }],
      format: "JSONEachRow",
    });

    // Run through the rule engine
    await runRuleEngine(signal);

    return reply.send({ success: true, message: "Signal processed", data: { signalId: signal.id } });
  });

  /** Full flow: seed rule + fund + trigger payout in one call */
  app.post("/test/full-flow", async (_req, reply) => {
    const steps: string[] = [];

    // 1. Seed rule if needed
    let rule = await getActiveRule();
    if (!rule) {
      const now = new Date().toISOString().replace("Z", "");
      await ch.insert({
        table: "payout_rules",
        values: [{
          id: randomUUID(),
          name: "Test Rule",
          distribution_method: "equal_split",
          max_payout_per_member: 10000,
          eligibility_radius_km: 500,
          min_severity_threshold: 3,
          proposed_by: "test-seed",
          approved_at: now,
          active: 1,
          created_at: now,
        }],
        format: "JSONEachRow",
      });
      rule = await getActiveRule();
      steps.push("Payout rule seeded");
    } else {
      steps.push("Payout rule already exists");
    }

    // 2. Add fund balance
    const now = new Date().toISOString().replace("Z", "");
    await ch.insert({
      table: "contributions",
      values: [{
        id: randomUUID(),
        member_id: "test-seed",
        amount: 100000,
        currency: "USD",
        frequency: "one-off",
        op_grant_id: "",
        op_incoming_payment_id: "test-" + randomUUID(),
        status: "completed",
        created_at: now,
      }],
      format: "JSONEachRow",
    });
    steps.push("Fund credited with 100000");

    // 3. Trigger disaster signal
    const signal: DisasterSignal = {
      id: randomUUID(),
      type: "earthquake",
      severity: 7,
      location: "Test Location",
      sourceApi: "test",
      sourceUrl: "",
      rawPayload: "{}",
      verified: true,
      verificationNote: "Test signal (full-flow)",
      detectedAt: now,
    };

    await ch.insert({
      table: "disaster_signals",
      values: [{
        id: signal.id,
        type: signal.type,
        severity: signal.severity,
        location: signal.location,
        source_api: signal.sourceApi,
        source_url: signal.sourceUrl,
        raw_payload: signal.rawPayload,
        verified: 1,
        verification_note: signal.verificationNote,
        detected_at: signal.detectedAt,
      }],
      format: "JSONEachRow",
    });
    steps.push("Disaster signal created");

    // 4. Run rule engine
    try {
      await runRuleEngine(signal);
      steps.push("Rule engine executed");
    } catch (err: any) {
      steps.push("Rule engine error: " + err.message);
    }

    return reply.send({ success: true, steps, rule, signalId: signal.id });
  });
}

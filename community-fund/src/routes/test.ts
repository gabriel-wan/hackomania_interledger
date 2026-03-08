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
import { getMemberByWallet, registerMember } from "../db/memberRegistry";
import { config } from "../config";
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
  // Known city coordinates for test signals
  const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
    singapore: { lat: 1.3521, lng: 103.8198 },
    manila: { lat: 14.5995, lng: 120.9842 },
    jakarta: { lat: -6.2088, lng: 106.8456 },
    tokyo: { lat: 35.6762, lng: 139.6503 },
    kathmandu: { lat: 27.7172, lng: 85.3240 },
  };

  app.post<{
    Body: {
      type?: string;
      severity?: number;
      location?: string;
      latitude?: number;
      longitude?: number;
      /** Wallet address to receive the payout. Defaults to the fund wallet (self-loop for testing). */
      recipientWalletAddress?: string;
    };
  }>("/test/trigger-payout", async (req, reply) => {
    // Ensure at least one member exists so the rule engine has someone to pay
    const recipientWallet = req.body?.recipientWalletAddress ?? config.openPayments.walletAddress;
    let member = await getMemberByWallet(recipientWallet);
    if (!member) {
      member = await registerMember({
        walletAddress: recipientWallet,
        name: "Test Member",
        email: "",
        location: "",
        latitude: 0,
        longitude: 0,
        consentGiven: true,
      });
    }

    // Resolve coordinates: explicit body params > city lookup > fallback 0,0
    const locationKey = (req.body?.location ?? "").toLowerCase();
    const cityMatch = Object.entries(CITY_COORDS).find(([k]) => locationKey.includes(k));
    const lat = req.body?.latitude ?? cityMatch?.[1].lat ?? 0;
    const lng = req.body?.longitude ?? cityMatch?.[1].lng ?? 0;

    const signal: DisasterSignal = {
      id: randomUUID(),
      type: (req.body?.type ?? "earthquake") as any,
      severity: req.body?.severity ?? 7,
      location: req.body?.location ?? "Test Location",
      latitude: lat,
      longitude: lng,
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
        latitude: signal.latitude,
        longitude: signal.longitude,
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
    const engineResult = await runRuleEngine(signal);

    return reply.send({ success: true, message: "Signal processed", data: { signalId: signal.id, engineResult } });
  });

  /** Full flow: seed rule + fund + trigger payout in one call */
  app.post<{ Body?: { recipientWalletAddress?: string } }>("/test/full-flow", async (req, reply) => {
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

    // 2. Ensure a test member exists so the rule engine has someone to pay
    const recipientWallet = req.body?.recipientWalletAddress ?? config.openPayments.walletAddress;
    let member = await getMemberByWallet(recipientWallet);
    if (!member) {
      member = await registerMember({
        walletAddress: recipientWallet,
        name: "Test Member",
        email: "",
        location: "",
        latitude: 0,
        longitude: 0,
        consentGiven: true,
      });
      steps.push(`Test member seeded: ${recipientWallet}`);
    } else {
      steps.push(`Test member already exists: ${recipientWallet}`);
    }

    // 3. Add fund balance
    const now = new Date().toISOString().replace("Z", "");
    await ch.insert({
      table: "contributions",
      values: [{
        id: randomUUID(),
        member_id: member.id,
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

    // 4. Trigger disaster signal (Singapore by default)
    const signal: DisasterSignal = {
      id: randomUUID(),
      type: "earthquake",
      severity: 7,
      location: "Singapore",
      latitude: 1.3521,
      longitude: 103.8198,
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
        latitude: signal.latitude,
        longitude: signal.longitude,
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

    // 5. Run rule engine
    let engineResult;
    try {
      engineResult = await runRuleEngine(signal);
      const succeeded = engineResult.payouts.filter(p => p.status === "ok").length;
      const failed = engineResult.payouts.filter(p => p.status === "failed").length;
      steps.push(`Rule engine executed: ${succeeded} payouts succeeded, ${failed} failed`);
      if (engineResult.skipped) steps.push(`Skipped: ${engineResult.skipped}`);
    } catch (err: any) {
      steps.push("Rule engine threw: " + (err?.description ?? err?.message));
    }

    return reply.send({ success: true, steps, rule, signalId: signal.id, engineResult });
  });
}

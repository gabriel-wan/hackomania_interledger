/**
 * Audit Routes (Public)
 * Exposes the fund's event log and chain integrity check.
 * These endpoints are unauthenticated — anyone can verify the fund history.
 *
 * GET /audit/events          - Full event log (paginated)
 * GET /audit/events/:id      - Single event with proof data
 * GET /audit/root-hash       - Latest chain root hash
 * GET /audit/verify          - Verify full chain integrity
 * GET /audit/payouts         - Public payout summary (anonymized)
 */

import { FastifyInstance } from "fastify";
import {
  getAllEvents,
  getEventById,
  getRootHash,
  verifyChainIntegrity,
  getEventsByType,
} from "../services/eventLog";
import { ch } from "../db/clickhouse";

export async function auditRoutes(app: FastifyInstance): Promise<void> {

  /**
   * Full paginated event log. Anyone can read this.
   */
  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/audit/events",
    async (req, reply) => {
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);

      const result = await ch.query({
        query: `
          SELECT * FROM audit_events ORDER BY timestamp ASC LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        `,
        query_params: { limit, offset },
        format: "JSONEachRow",
      });
      const rows = await result.json<any>();

      const countResult = await ch.query({
        query: "SELECT count() as count FROM audit_events",
        format: "JSONEachRow",
      });
      const countRows = await countResult.json<{ count: string }>();
      const total = Number(countRows[0]?.count ?? 0);

      return reply.send({ success: true, data: rows, total, limit, offset });
    }
  );

  /**
   * Single event — includes prevHash for manual chain verification.
   */
  app.get<{ Params: { id: string } }>(
    "/audit/events/:id",
    async (req, reply) => {
      const event = await getEventById(req.params.id);
      if (!event) {
        return reply.status(404).send({ success: false, error: "Event not found." });
      }
      return reply.send({ success: true, data: event });
    }
  );

  /**
   * Current root hash — publish this to IPFS or a public page periodically.
   */
  app.get("/audit/root-hash", async (_req, reply) => {
    return reply.send({
      success: true,
      data: {
        rootHash: await getRootHash(),
        timestamp: new Date().toISOString(),
      },
    });
  });

  /**
   * Full chain integrity check. Returns valid/invalid and the offending event ID.
   */
  app.get("/audit/verify", async (_req, reply) => {
    const result = await verifyChainIntegrity();
    return reply.send({ success: true, data: result });
  });

  /**
   * Anonymized public payout summary — amounts and rules, no member identity.
   */
  app.get("/audit/payouts", async (_req, reply) => {
    const result = await ch.query({
      query: `
        SELECT
          p.id,
          p.disaster_signal_id,
          p.amount,
          p.currency,
          p.rule_id,
          p.op_outgoing_payment_id,
          p.status,
          p.created_at,
          r.name as rule_name,
          r.distribution_method,
          d.type as disaster_type,
          d.severity as disaster_severity,
          d.location as disaster_location,
          d.source_api as disaster_source
        FROM payouts p
        JOIN payout_rules r ON p.rule_id = r.id
        JOIN disaster_signals d ON p.disaster_signal_id = d.id
        ORDER BY p.created_at DESC
      `,
      format: "JSONEachRow",
    });
    const rows = await result.json<any>();

    return reply.send({ success: true, data: rows });
  });
}

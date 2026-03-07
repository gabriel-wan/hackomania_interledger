/**
 * Dashboard Routes
 * Feeds the frontend with aggregated fund data.
 * Public view returns anonymized stats; member view requires auth.
 *
 * GET /dashboard/public     - Fund balance, contribution totals, payout summary
 * GET /dashboard/member/:id - Member-specific contribution and payout history
 * GET /dashboard/signals    - Recent disaster signals
 */

import { FastifyInstance } from "fastify";
import { getBalance } from "../db/fundPool";
import { ch } from "../db/clickhouse";

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {

  /**
   * Public dashboard — no auth required.
   * Shows aggregate fund health without exposing member identity.
   */
  app.get("/dashboard/public", async (_req, reply) => {
    const pool = await getBalance();

    const contributionResult = await ch.query({
      query: `
        SELECT COUNT(*) as count, SUM(amount) as total
        FROM contributions WHERE status = 'completed'
      `,
      format: "JSONEachRow",
    });
    const contributionRows = await contributionResult.json<any>();
    const contributionStats = contributionRows[0] ?? { count: 0, total: 0 };

    const payoutResult = await ch.query({
      query: `
        SELECT COUNT(*) as count, SUM(amount) as total
        FROM payouts WHERE status = 'completed'
      `,
      format: "JSONEachRow",
    });
    const payoutRows = await payoutResult.json<any>();
    const payoutStats = payoutRows[0] ?? { count: 0, total: 0 };

    const memberResult = await ch.query({
      query: "SELECT count() as count FROM members",
      format: "JSONEachRow",
    });
    const memberRows = await memberResult.json<{ count: string }>();
    const memberCount = Number(memberRows[0]?.count ?? 0);

    const recentPayoutsResult = await ch.query({
      query: `
        SELECT p.amount, p.currency, p.created_at,
               d.type as disaster_type, d.location, r.distribution_method
        FROM payouts p
        JOIN disaster_signals d ON p.disaster_signal_id = d.id
        JOIN payout_rules r ON p.rule_id = r.id
        WHERE p.status = 'completed'
        ORDER BY p.created_at DESC
        LIMIT 10
      `,
      format: "JSONEachRow",
    });
    const recentPayouts = await recentPayoutsResult.json<any>();

    return reply.send({
      success: true,
      data: {
        fund: {
          balance: pool.totalBalance,
          currency: pool.currency,
          lastUpdated: pool.lastUpdated,
        },
        members: { total: memberCount },
        contributions: {
          count: Number(contributionStats.count ?? 0),
          total: Number(contributionStats.total ?? 0),
        },
        payouts: {
          count: Number(payoutStats.count ?? 0),
          total: Number(payoutStats.total ?? 0),
        },
        recentPayouts,
      },
    });
  });

  /**
   * Member-specific view — should be protected by JWT in production.
   * Shows a member's own contributions and any payouts they received.
   */
  app.get<{ Params: { id: string } }>(
    "/dashboard/member/:id",
    async (req, reply) => {
      const memberId = req.params.id;

      const contributionsResult = await ch.query({
        query: `
          SELECT * FROM contributions WHERE member_id = {memberId:String} ORDER BY created_at DESC
        `,
        query_params: { memberId },
        format: "JSONEachRow",
      });
      const contributions = await contributionsResult.json<any>();

      const payoutsResult = await ch.query({
        query: `
          SELECT p.*, d.type as disaster_type, d.location, r.name as rule_name
          FROM payouts p
          JOIN disaster_signals d ON p.disaster_signal_id = d.id
          JOIN payout_rules r ON p.rule_id = r.id
          WHERE p.member_id = {memberId:String}
          ORDER BY p.created_at DESC
        `,
        query_params: { memberId },
        format: "JSONEachRow",
      });
      const payouts = await payoutsResult.json<any>();

      return reply.send({ success: true, data: { contributions, payouts } });
    }
  );

  /**
   * Recent disaster signals — public, includes verification status.
   */
  app.get("/dashboard/signals", async (_req, reply) => {
    const result = await ch.query({
      query: `
        SELECT id, type, severity, location, latitude, longitude,
               source_api, source_url, verified, verification_note, detected_at
        FROM disaster_signals
        ORDER BY detected_at DESC
        LIMIT 20
      `,
      format: "JSONEachRow",
    });
    const signals = await result.json<any>();

    return reply.send({ success: true, data: signals });
  });
}

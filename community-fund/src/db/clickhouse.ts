/**
 * ClickHouse Client
 * ClickHouse is the primary database for this project.
 *
 * Why ClickHouse fits this architecture:
 *   - Append-only event log is a natural fit for ClickHouse's MergeTree engine
 *   - Contributions and payouts are high-volume insert workloads
 *   - Dashboard aggregations (SUM, COUNT, GROUP BY) run extremely fast
 *   - The audit log is immutable by design — no UPDATE/DELETE needed
 *
 * Table engine choices:
 *   MergeTree         - append-only tables (events, contributions, payouts, signals)
 *   ReplacingMergeTree - mutable tables where latest row wins (members, fund_pool, rules)
 *
 * NOTE: ReplacingMergeTree deduplication is eventually consistent.
 *       Use FINAL keyword in SELECT queries on these tables for accurate results.
 *       e.g. SELECT * FROM members FINAL WHERE id = ?
 *
 * Setup: docker run -d -p 8123:8123 -p 9000:9000 clickhouse/clickhouse-server
 */

import { createClient, ClickHouseClient } from "@clickhouse/client";
import { config } from "../config";

export let ch: ClickHouseClient;

export async function initClickHouse(): Promise<void> {
  ch = createClient({
    url: config.db.clickhouseUrl,
    username: config.db.clickhouseUser,
    password: config.db.clickhousePassword,
    database: config.db.clickhouseDb,
  });

  await ch.ping();
  console.log("ClickHouse connected.");
  await createTables();
}

async function execDDL(query: string): Promise<void> {
  const result = await ch.exec({ query });
  result.stream.on("data", () => {});
  await new Promise<void>((resolve) => result.stream.on("end", resolve));
}

async function createTables(): Promise<void> {
  // Members — ReplacingMergeTree so profile updates replace old rows
  await execDDL(`
    CREATE TABLE IF NOT EXISTS members (
      id           String,
      wallet_address String,
      name         String,
      email        String,
      location     String,
      latitude     Float64,
      longitude    Float64,
      consent_given UInt8,
      consent_timestamp DateTime64(3, 'UTC'),
      created_at   DateTime64(3, 'UTC')
    )
    ENGINE = ReplacingMergeTree(created_at)
    ORDER BY (id)
  `);

  // Fund pool snapshots — append balance snapshots, query latest
  await execDDL(`
    CREATE TABLE IF NOT EXISTS fund_pool_snapshots (
      id           String,
      total_balance Int64,
      currency     String,
      snapshot_at  DateTime64(3, 'UTC')
    )
    ENGINE = MergeTree()
    ORDER BY (snapshot_at)
  `);

  // Contributions — pure append, no updates
  await execDDL(`
    CREATE TABLE IF NOT EXISTS contributions (
      id                     String,
      member_id              String,
      amount                 Int64,
      currency               String,
      frequency              String,
      op_grant_id            String,
      op_incoming_payment_id String,
      status                 String,
      created_at             DateTime64(3, 'UTC')
    )
    ENGINE = MergeTree()
    ORDER BY (created_at, member_id)
  `);

  // Payout rules — ReplacingMergeTree so governance updates replace old rules
  await execDDL(`
    CREATE TABLE IF NOT EXISTS payout_rules (
      id                      String,
      name                    String,
      distribution_method     String,
      max_payout_per_member   Int64,
      eligibility_radius_km   Int32,
      min_severity_threshold  Int32,
      proposed_by             String,
      approved_at             Nullable(DateTime64(3, 'UTC')),
      active                  UInt8,
      created_at              DateTime64(3, 'UTC')
    )
    ENGINE = ReplacingMergeTree(created_at)
    ORDER BY (id)
  `);

  // Disaster signals — append only
  await execDDL(`
    CREATE TABLE IF NOT EXISTS disaster_signals (
      id                String,
      type              String,
      severity          Int32,
      location          String,
      latitude          Float64,
      longitude         Float64,
      source_api        String,
      source_url        String,
      raw_payload       String,
      verified          UInt8,
      verification_note String,
      detected_at       DateTime64(3, 'UTC')
    )
    ENGINE = MergeTree()
    ORDER BY (detected_at, type)
  `);

  // Payouts — append only, joins to signals and rules at query time
  await execDDL(`
    CREATE TABLE IF NOT EXISTS payouts (
      id                      String,
      disaster_signal_id      String,
      member_id               String,
      amount                  Int64,
      currency                String,
      rule_id                 String,
      op_outgoing_payment_id  String,
      status                  String,
      created_at              DateTime64(3, 'UTC')
    )
    ENGINE = MergeTree()
    ORDER BY (created_at, member_id)
  `);

  // Governance proposals — ReplacingMergeTree (vote counts update)
  await execDDL(`
    CREATE TABLE IF NOT EXISTS proposals (
      id           String,
      type         String,
      title        String,
      description  String,
      proposed_by  String,
      payload      String,
      votes_yes    Int32,
      votes_no     Int32,
      votes_abstain Int32,
      status       String,
      expires_at   DateTime64(3, 'UTC'),
      created_at   DateTime64(3, 'UTC')
    )
    ENGINE = ReplacingMergeTree(created_at)
    ORDER BY (id)
  `);

  // Votes — append only (one row per member per proposal)
  await execDDL(`
    CREATE TABLE IF NOT EXISTS votes (
      id           String,
      proposal_id  String,
      member_id    String,
      choice       String,
      created_at   DateTime64(3, 'UTC')
    )
    ENGINE = MergeTree()
    ORDER BY (proposal_id, member_id)
  `);

  // Audit event log — pure append, cryptographically chained
  // MergeTree guarantees no mutation — ideal for tamper-evident log
  await execDDL(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id        String,
      type      String,
      payload   String,
      op_tx_id  Nullable(String),
      prev_hash String,
      hash      String,
      timestamp DateTime64(3, 'UTC')
    )
    ENGINE = MergeTree()
    ORDER BY (timestamp, id)
  `);

  console.log("ClickHouse tables ready.");
}

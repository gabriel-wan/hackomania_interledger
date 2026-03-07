/**
 * Fund Pool
 * Balance is derived by summing completed contributions minus completed payouts.
 * This is the natural ClickHouse approach — no mutable single-row balance needed.
 */

import { ch } from "./clickhouse";
import { FundPool } from "../types";

export async function getBalance(): Promise<FundPool> {
  const result = await ch.query({
    query: `
      SELECT
        (SELECT coalesce(sum(amount), 0) FROM contributions WHERE status = 'completed')
        - (SELECT coalesce(sum(amount), 0) FROM payouts WHERE status = 'completed')
        AS total_balance
    `,
    format: "JSONEachRow",
  });
  const rows = await result.json<{ total_balance: string }>();
  return {
    id: "main",
    totalBalance: Number(rows[0]?.total_balance ?? 0),
    currency: "SGD",
    lastUpdated: new Date().toISOString(),
  };
}

export async function creditFund(_amount: number): Promise<FundPool> {
  return getBalance();
}

export async function debitFund(amount: number): Promise<FundPool> {
  const pool = await getBalance();
  if (pool.totalBalance < amount) {
    throw new Error(`Insufficient fund balance. Required: ${amount}, Available: ${pool.totalBalance}`);
  }
  return getBalance();
}

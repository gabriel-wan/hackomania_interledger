/**
 * DEPRECATED: This file is obsolete and should be deleted.
 * All database operations have been migrated to ClickHouse (@clickhouse/client).
 * 
 * This SQLite schema is no longer used. Please use the ClickHouse client
 * exported from ./clickhouse.ts for all database operations.
 * 
 * Migration summary:
 * - fundPool.ts: Using ch.query() and ch.insert() for balance calculations
 * - memberRegistry.ts: Using ch.query() and ch.insert() for member operations
 * - eventLog.ts: Using ch.insert() and ch.query() for audit trail
 * - governanceModule.ts: Using ch.insert() and ch.query() for proposals/votes
 * - ruleEngine.ts: Using ch.insert() and ch.query() for payouts
 * - All routes: Migrated to ClickHouse operations
 */

export const db = {} as any;

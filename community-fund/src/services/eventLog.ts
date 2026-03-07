/**
 * Append-Only Event Log
 * Every state change in the system is recorded here as an immutable event.
 * Events are cryptographically chained: each event hashes the previous
 * event's hash, making retroactive tampering detectable.
 *
 * Chain integrity:
 *   hash(n) = SHA-256(prevHash + type + payload + timestamp)
 */

import { createHash, randomUUID } from "crypto";
import { ch } from "../db/clickhouse";
import { AuditEvent, EventType } from "../types";

export async function logEvent(params: {
  type: EventType;
  payload: object;
  opTxId: string | null;
}): Promise<AuditEvent> {
  const prevEvent = await getLatestEvent();
  const prevHash = prevEvent?.hash ?? "0".repeat(64);
  const timestamp = new Date().toISOString();
  const payloadStr = JSON.stringify(params.payload);

  const hash = createHash("sha256")
    .update(prevHash + params.type + payloadStr + timestamp)
    .digest("hex");

  const event: AuditEvent = {
    id: randomUUID(),
    type: params.type,
    payload: payloadStr,
    opTxId: params.opTxId,
    prevHash,
    hash,
    timestamp,
  };

  await ch.insert({
    table: "audit_events",
    values: [{
      id: event.id,
      type: event.type,
      payload: event.payload,
      op_tx_id: event.opTxId ?? null,
      prev_hash: event.prevHash,
      hash: event.hash,
      timestamp: event.timestamp,
    }],
    format: "JSONEachRow",
  });

  return event;
}

export async function getLatestEvent(): Promise<AuditEvent | null> {
  const result = await ch.query({
    query: "SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT 1",
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getEventById(id: string): Promise<AuditEvent | null> {
  const result = await ch.query({
    query: "SELECT * FROM audit_events WHERE id = {id:String} LIMIT 1",
    query_params: { id },
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getAllEvents(): Promise<AuditEvent[]> {
  const result = await ch.query({
    query: "SELECT * FROM audit_events ORDER BY timestamp ASC",
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows.map(mapRow);
}

export async function getEventsByType(type: EventType): Promise<AuditEvent[]> {
  const result = await ch.query({
    query: "SELECT * FROM audit_events WHERE type = {type:String} ORDER BY timestamp ASC",
    query_params: { type },
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows.map(mapRow);
}

export async function verifyChainIntegrity(): Promise<{ valid: boolean; invalidEventId?: string }> {
  const events = await getAllEvents();
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const expectedPrevHash = i === 0 ? "0".repeat(64) : events[i - 1].hash;
    const expectedHash = createHash("sha256")
      .update(expectedPrevHash + event.type + event.payload + event.timestamp)
      .digest("hex");
    if (event.hash !== expectedHash || event.prevHash !== expectedPrevHash) {
      return { valid: false, invalidEventId: event.id };
    }
  }
  return { valid: true };
}

export async function getRootHash(): Promise<string> {
  const latest = await getLatestEvent();
  return latest?.hash ?? "0".repeat(64);
}

function mapRow(row: any): AuditEvent {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    opTxId: row.op_tx_id,
    prevHash: row.prev_hash,
    hash: row.hash,
    timestamp: row.timestamp,
  };
}

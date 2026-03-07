/**
 * Member Registry
 * Handles member identity and consent storage.
 * Consent must be explicitly given before any member data is processed.
 */

import { randomUUID } from "crypto";
import { ch } from "./clickhouse";
import { Member, MemberRegistrationPayload } from "../types";

export async function registerMember(payload: MemberRegistrationPayload): Promise<Member> {
  if (!payload.consentGiven) {
    throw new Error("Member must give explicit consent before registration.");
  }
  const member: Member = {
    id: randomUUID(),
    walletAddress: payload.walletAddress,
    name: payload.name,
    email: payload.email,
    location: payload.location,
    latitude: payload.latitude ?? 0,
    longitude: payload.longitude ?? 0,
    consentGiven: payload.consentGiven,
    consentTimestamp: new Date().toISOString().replace("Z", ""),
    createdAt: new Date().toISOString().replace("Z", ""),
  };
  await ch.insert({
    table: "members",
    values: [{
      id: member.id,
      wallet_address: member.walletAddress,
      name: member.name,
      email: member.email,
      location: member.location,
      latitude: member.latitude,
      longitude: member.longitude,
      consent_given: member.consentGiven ? 1 : 0,
      consent_timestamp: member.consentTimestamp,
      created_at: member.createdAt,
    }],
    format: "JSONEachRow",
  });
  return member;
}

export async function getMemberById(id: string): Promise<Member | null> {
  const result = await ch.query({
    query: "SELECT * FROM members FINAL WHERE id = {id:String} LIMIT 1",
    query_params: { id },
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getMemberByWallet(walletAddress: string): Promise<Member | null> {
  const result = await ch.query({
    query: "SELECT * FROM members FINAL WHERE wallet_address = {wa:String} LIMIT 1",
    query_params: { wa: walletAddress },
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getMembersInRadius(latitude: number, longitude: number, radiusKm: number): Promise<Member[]> {
  const result = await ch.query({
    query: `SELECT * FROM members FINAL
            WHERE consent_given = 1
              AND geoDistance({lng:Float64}, {lat:Float64}, longitude, latitude) / 1000 <= {radius:Float64}`,
    query_params: { lat: latitude, lng: longitude, radius: radiusKm },
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows.map(mapRow);
}

export async function getAllMembers(): Promise<Member[]> {
  const result = await ch.query({
    query: "SELECT * FROM members FINAL",
    format: "JSONEachRow",
  });
  const rows = await result.json<any>();
  return rows.map(mapRow);
}

function mapRow(row: any): Member {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    name: row.name,
    email: row.email,
    location: row.location,
    latitude: Number(row.latitude) || 0,
    longitude: Number(row.longitude) || 0,
    consentGiven: Boolean(Number(row.consent_given)),
    consentTimestamp: row.consent_timestamp,
    createdAt: row.created_at,
  };
}

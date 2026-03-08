/**
 * Seed Script — Bulk-generate test members with randomized lat/lng
 *
 * Usage:
 *   npm run seed                          # 500 members around Singapore
 *   npm run seed -- --count 1000          # 1000 members
 *   npm run seed -- --lat 14.5 --lng 121  # centered on Manila
 *   npm run seed -- --spread 0.5          # tighter cluster (degrees)
 *   npm run seed -- --clear               # delete existing members first
 *
 * Members are inserted directly into ClickHouse (no server required).
 * Wallet addresses use placeholder format for demo purposes.
 */

import { createClient } from "@clickhouse/client";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function getArg(name: string, defaultValue: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}

const COUNT = parseInt(getArg("count", "500"));
const CENTER_LAT = parseFloat(getArg("lat", "1.3521"));   // Singapore
const CENTER_LNG = parseFloat(getArg("lng", "103.8198")); // Singapore
const SPREAD = parseFloat(getArg("spread", "0.8"));       // ~80km radius
const WALLET = getArg("wallet", "");                       // shared wallet for all seeded members
const CLEAR = process.argv.includes("--clear");

// ---------------------------------------------------------------------------
// ClickHouse client
// ---------------------------------------------------------------------------

const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: process.env.CLICKHOUSE_DB ?? "community_fund",
});

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  "Aarav", "Mei", "Carlos", "Fatima", "Hiroshi", "Amara", "Liam", "Priya",
  "Chen", "Sofia", "Ravi", "Yuki", "Omar", "Ingrid", "Tariq", "Aisha",
  "Jun", "Maria", "Kwame", "Sari", "Raj", "Nina", "Ali", "Hana", "Wei",
  "Elena", "Davi", "Zara", "Koji", "Isla", "Arun", "Lily", "Hassan",
];

const LAST_NAMES = [
  "Tan", "Lee", "Kumar", "Santos", "Nguyen", "Kim", "Chen", "Singh",
  "Garcia", "Yamamoto", "Ali", "Rahman", "Wong", "Park", "Nakamura",
  "Patel", "Lopez", "Sato", "Ibrahim", "Lim", "Fernandez", "Takahashi",
  "Ahmad", "Chan", "Das", "Reyes", "Wu", "Sharma", "Mendoza", "Choi",
];

const LOCATIONS = [
  "Bedok", "Tampines", "Jurong", "Woodlands", "Bishan", "Clementi",
  "Toa Payoh", "Punggol", "Sengkang", "Bukit Panjang", "Hougang",
  "Pasir Ris", "Yishun", "Ang Mo Kio", "Queenstown", "Bukit Merah",
  "Geylang", "Marine Parade", "Serangoon", "Choa Chu Kang",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function gaussianRandom(): number {
  // Box-Muller transform for clustered distribution
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function randomLat(): number {
  return CENTER_LAT + gaussianRandom() * SPREAD * 0.5;
}

function randomLng(): number {
  return CENTER_LNG + gaussianRandom() * SPREAD * 0.5;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Seeding ${COUNT} members around (${CENTER_LAT}, ${CENTER_LNG}) with spread ${SPREAD}°`);

  await ch.ping();
  console.log("ClickHouse connected.");

  if (CLEAR) {
    console.log("Clearing existing members...");
    const result = await ch.exec({ query: "TRUNCATE TABLE members" });
    result.stream.on("data", () => {});
    await new Promise<void>((resolve) => result.stream.on("end", resolve));
    console.log("Members table cleared.");
  }

  const BATCH_SIZE = 200;
  let inserted = 0;

  for (let i = 0; i < COUNT; i += BATCH_SIZE) {
    const batchCount = Math.min(BATCH_SIZE, COUNT - i);
    const rows = [];

    for (let j = 0; j < batchCount; j++) {
      const firstName = pick(FIRST_NAMES);
      const lastName = pick(LAST_NAMES);
      const now = new Date().toISOString().replace("Z", "");

      rows.push({
        id: randomUUID(),
        wallet_address: WALLET
          ? `https://ilp.interledger-test.dev/${WALLET}`
          : `https://ilp.interledger-test.dev/seed_${randomUUID().slice(0, 8)}`,
        name: `${firstName} ${lastName}`,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(Math.random() * 999)}@example.com`,
        location: pick(LOCATIONS),
        latitude: randomLat(),
        longitude: randomLng(),
        consent_given: 1,
        consent_timestamp: now,
        created_at: now,
      });
    }

    await ch.insert({
      table: "members",
      values: rows,
      format: "JSONEachRow",
    });

    inserted += batchCount;
    console.log(`  Inserted ${inserted}/${COUNT} members`);
  }

  console.log(`Done! ${COUNT} members seeded.`);

  // Quick stats
  const stats = await ch.query({
    query: `SELECT
              count() as total,
              min(latitude) as minLat, max(latitude) as maxLat,
              min(longitude) as minLng, max(longitude) as maxLng
            FROM members FINAL WHERE consent_given = 1`,
    format: "JSONEachRow",
  });
  const s = (await stats.json<any>())[0];
  console.log(`Total members: ${s.total}`);
  console.log(`Lat range: ${Number(s.minLat).toFixed(4)} to ${Number(s.maxLat).toFixed(4)}`);
  console.log(`Lng range: ${Number(s.minLng).toFixed(4)} to ${Number(s.maxLng).toFixed(4)}`);

  await ch.close();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

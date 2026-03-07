/**
 * Central configuration module.
 * All environment variables are validated and accessed from here.
 * Never import process.env directly in other modules.
 */

import dotenv from "dotenv";
dotenv.config();

function require(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config = {
  server: {
    port: parseInt(process.env.PORT ?? "3000"),
    env: process.env.NODE_ENV ?? "development",
  },

  openPayments: {
    walletAddress: require("OP_WALLET_ADDRESS"),
    privateKeyPath: require("OP_PRIVATE_KEY_PATH", "./private.key"),
    keyId: require("OP_KEY_ID"),
  },

  db: {
    clickhouseUrl: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    clickhouseUser: process.env.CLICKHOUSE_USER ?? "default",
    clickhousePassword: process.env.CLICKHOUSE_PASSWORD ?? "",
    clickhouseDb: process.env.CLICKHOUSE_DB ?? "community_fund",
  },

  ai: {
    enabled: process.env.AI_ENABLED === "true",
    apiKey: process.env.AI_API_KEY ?? "",
    apiUrl: process.env.AI_API_URL ?? "",
  },

  disasterSources: {
    usgs: process.env.USGS_API_URL ?? "https://earthquake.usgs.gov/fdsnws/event/1",
    weather: process.env.WEATHER_API_URL ?? "https://api.weather.gov",
    flood: process.env.FLOOD_API_URL ?? "",
  },

  auth: {
    jwtSecret: require("JWT_SECRET", "dev-secret-change-in-prod"),
  },

  audit: {
    ipfsUrl: process.env.IPFS_API_URL ?? "",
    ipfsKey: process.env.IPFS_API_KEY ?? "",
  },
};

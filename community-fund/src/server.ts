/**
 * Server Entry Point
 * Initializes all layers in order:
 *   1. Database
 *   2. Open Payments client
 *   3. Fastify routes
 *   4. Disaster trigger engine (polling loop)
 *   5. Governance tally loop
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "path";
import { config } from "./config";
import { initClickHouse } from "./db/clickhouse";
import { initPaymentsClient } from "./services/payments";
import { startTriggerEngine } from "./services/triggerEngine";
import { tallyExpiredProposals } from "./services/governanceModule";
import { memberRoutes } from "./routes/members";
import { contributionRoutes } from "./routes/contributions";
import { governanceRoutes } from "./routes/governance";
import { auditRoutes } from "./routes/audit";
import { dashboardRoutes } from "./routes/dashboard";
import { testRoutes } from "./routes/test";
import { contributeRoutes } from "./routes/contribute";

const app = Fastify({ logger: true });

async function bootstrap(): Promise<void> {
  // 1. Database
  await initClickHouse();

  // 2. Open Payments client
  await initPaymentsClient();

  // 3. Middleware
  await app.register(cors, { origin: true });

  // 4. Routes (register BEFORE static to avoid catch-all conflicts)
  await app.register(memberRoutes);
  await app.register(contributionRoutes);
  await app.register(governanceRoutes);
  await app.register(auditRoutes);
  await app.register(dashboardRoutes);
  await app.register(testRoutes);
  await app.register(contributeRoutes);

  // 5. Static files (after routes so API routes take priority)
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/",
    wildcard: false,
  });

  // 5. Health check
  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: config.server.env,
  }));

  // 6. Start server
  await app.listen({ port: config.server.port, host: "0.0.0.0" });
  console.log(`Server running on port ${config.server.port}`);

  // 7. Disaster trigger engine — polls every 5 minutes
  startTriggerEngine(5 * 60 * 1000);

  // 8. Governance tally loop — checks for expired proposals every hour
  setInterval(tallyExpiredProposals, 60 * 60 * 1000);
  tallyExpiredProposals(); // Run once on startup
}

bootstrap().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

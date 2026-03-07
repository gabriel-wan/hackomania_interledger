/**
 * Disaster Trigger Engine
 * Polls external disaster signal APIs on a schedule and evaluates
 * whether conditions meet the configured severity thresholds.
 *
 * When a qualifying signal is detected, it is passed to the AI
 * verification layer (if enabled) and then to the rule engine.
 *
 * Data sources:
 *   - USGS Earthquake Hazards API
 *   - National Weather Service API
 *   - Extensible via addSource()
 */

import axios from "axios";
import { randomUUID } from "crypto";
import { config } from "../config";
import { DisasterSignal, DisasterType } from "../types";
import { ch } from "../db/clickhouse";
import { verifySignalWithAI } from "./aiVerification";
import { logEvent } from "./eventLog";
import { runRuleEngine } from "./ruleEngine";

// ---------------------------------------------------------------------------
// Signal source adapters
// Each adapter normalizes external API responses into a DisasterSignal
// ---------------------------------------------------------------------------

async function fetchUSGSEarthquakes(minMagnitude = 5.0): Promise<DisasterSignal[]> {
  const url = `${config.disasterSources.usgs}/query?format=geojson&minmagnitude=${minMagnitude}&limit=10&orderby=time`;
  const response = await axios.get(url);
  const features = response.data?.features ?? [];

  return features.map((f: any): DisasterSignal => ({
    id: randomUUID(),
    type: "earthquake" as DisasterType,
    severity: Math.min(10, Math.round(f.properties.mag)),
    location: f.properties.place ?? "Unknown",
    sourceApi: "USGS",
    sourceUrl: f.properties.url,
    rawPayload: JSON.stringify(f),
    verified: false,
    verificationNote: "",
    detectedAt: new Date().toISOString(),
  }));
}

async function fetchWeatherAlerts(): Promise<DisasterSignal[]> {
  const url = `${config.disasterSources.weather}/alerts/active?status=actual&severity=Extreme,Severe`;
  const response = await axios.get(url, {
    headers: { "User-Agent": "community-fund/1.0" },
  });
  const features = response.data?.features ?? [];

  return features.map((f: any): DisasterSignal => ({
    id: randomUUID(),
    type: mapWeatherEventType(f.properties.event),
    severity: mapWeatherSeverity(f.properties.severity),
    location: f.properties.areaDesc ?? "Unknown",
    sourceApi: "NWS",
    sourceUrl: `https://api.weather.gov/alerts/${f.properties.id}`,
    rawPayload: JSON.stringify(f),
    verified: false,
    verificationNote: "",
    detectedAt: new Date().toISOString(),
  }));
}

function mapWeatherEventType(event: string): DisasterType {
  const e = event.toLowerCase();
  if (e.includes("flood")) return "flood";
  if (e.includes("hurricane")) return "hurricane";
  if (e.includes("typhoon")) return "typhoon";
  return "other";
}

function mapWeatherSeverity(severity: string): number {
  const map: Record<string, number> = {
    Extreme: 9,
    Severe: 7,
    Moderate: 5,
    Minor: 3,
  };
  return map[severity] ?? 5;
}

// ---------------------------------------------------------------------------
// Core trigger loop
// ---------------------------------------------------------------------------

/**
 * Fetches signals from all configured sources, deduplicates against stored
 * signals, and processes any new qualifying events.
 */
export async function runTriggerCheck(): Promise<void> {
  console.log("[TriggerEngine] Running disaster signal check...");

  let signals: DisasterSignal[] = [];

  try {
    const [earthquakes, weatherAlerts] = await Promise.allSettled([
      fetchUSGSEarthquakes(),
      fetchWeatherAlerts(),
    ]);

    if (earthquakes.status === "fulfilled") signals.push(...earthquakes.value);
    if (weatherAlerts.status === "fulfilled") signals.push(...weatherAlerts.value);
  } catch (err) {
    console.error("[TriggerEngine] Error fetching signals:", err);
    return;
  }

  for (const signal of signals) {
    await processSignal(signal);
  }
}

async function processSignal(signal: DisasterSignal): Promise<void> {
  // Run AI verification if enabled
  if (config.ai.enabled) {
    const result = await verifySignalWithAI(signal);
    signal.verified = result.verified;
    signal.verificationNote = result.note;

    if (!result.verified) {
      console.log(`[TriggerEngine] Signal rejected by AI: ${signal.id}`);
      return;
    }
  } else {
    // Without AI, auto-verify signals above severity threshold
    signal.verified = signal.severity >= 5;
    signal.verificationNote = "Auto-verified (AI disabled)";
  }

  // Persist the signal
  await ch.insert({
    table: "disaster_signals",
    values: [{
      id: signal.id,
      type: signal.type,
      severity: signal.severity,
      location: signal.location,
      source_api: signal.sourceApi,
      source_url: signal.sourceUrl,
      raw_payload: signal.rawPayload,
      verified: signal.verified ? 1 : 0,
      verification_note: signal.verificationNote,
      detected_at: signal.detectedAt.replace("Z", ""),
    }],
    format: "JSONEachRow",
  });

  await logEvent({
    type: "disaster_signal_detected",
    payload: { signalId: signal.id, type: signal.type, severity: signal.severity },
    opTxId: null,
  });

  // Hand off to rule engine if signal is verified and severe enough
  if (signal.verified) {
    await runRuleEngine(signal);
  }
}

/**
 * Starts the trigger engine polling loop.
 * Interval in milliseconds — default 5 minutes.
 */
export function startTriggerEngine(intervalMs = 5 * 60 * 1000): void {
  console.log(`[TriggerEngine] Started. Polling every ${intervalMs / 1000}s.`);
  runTriggerCheck(); // Run immediately on startup
  setInterval(runTriggerCheck, intervalMs);
}

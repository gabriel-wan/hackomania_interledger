/**
 * AI Verification Layer (Optional)
 * Cross-checks disaster signals from external APIs before allowing
 * the rule engine to trigger payouts.
 *
 * Enabled via AI_ENABLED=true in .env.
 * If disabled, signals are auto-verified based on severity threshold only.
 *
 * The AI prompt asks the model to assess signal credibility given:
 *   - Signal type, severity, and location
 *   - Raw API payload
 *   - Cross-reference against known disaster data patterns
 *
 * Replace the provider implementation below with any LLM API.
 */

import axios from "axios";
import { config } from "../config";
import { DisasterSignal } from "../types";

export interface VerificationResult {
  verified: boolean;
  confidence: number; // 0.0 - 1.0
  note: string;
}

/**
 * Submits a disaster signal to the AI layer for credibility assessment.
 * Returns a verification result with confidence score and reasoning note.
 */
export async function verifySignalWithAI(
  signal: DisasterSignal
): Promise<VerificationResult> {
  if (!config.ai.enabled) {
    return {
      verified: signal.severity >= 5,
      confidence: 1.0,
      note: "AI disabled — auto-verified by severity threshold.",
    };
  }

  try {
    const prompt = buildVerificationPrompt(signal);
    const response = await callAIProvider(prompt);
    return parseAIResponse(response);
  } catch (err) {
    console.error("[AIVerification] Error calling AI provider:", err);
    // Fail safe: do not verify if AI call fails
    return {
      verified: false,
      confidence: 0,
      note: "AI verification failed — signal held pending manual review.",
    };
  }
}

function buildVerificationPrompt(signal: DisasterSignal): string {
  return `
You are a disaster signal verifier for a community emergency fund system.
Assess whether the following disaster signal is credible and warrants releasing emergency funds.

Signal details:
- Type: ${signal.type}
- Severity: ${signal.severity}/10
- Location: ${signal.location}
- Source: ${signal.sourceApi} (${signal.sourceUrl})
- Detected at: ${signal.detectedAt}

Raw signal data:
${signal.rawPayload}

Respond in JSON format only:
{
  "verified": true/false,
  "confidence": 0.0-1.0,
  "note": "brief explanation"
}

Criteria for verification:
- Signal comes from a known authoritative source (USGS, NWS, etc.)
- Severity is consistent with the event description
- Location data is coherent
- No obvious indicators of test data or false alert
`.trim();
}

async function callAIProvider(prompt: string): Promise<string> {
  // Default implementation uses OpenAI-compatible API.
  // Swap the URL and payload shape for other providers (Anthropic, Mistral, etc.)
  const response = await axios.post(
    `${config.ai.apiUrl}/chat/completions`,
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.choices[0].message.content;
}

function parseAIResponse(raw: string): VerificationResult {
  try {
    const parsed = JSON.parse(raw);
    return {
      verified: Boolean(parsed.verified),
      confidence: Number(parsed.confidence ?? 0),
      note: String(parsed.note ?? ""),
    };
  } catch {
    return {
      verified: false,
      confidence: 0,
      note: "Failed to parse AI response.",
    };
  }
}

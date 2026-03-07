/**
 * Payout Auth Token Cache
 * Stores a pre-authorized access token obtained via the admin payout auth flow.
 * The rule engine checks for a cached token before requesting per-payout grants.
 */

let cachedPayoutToken: string | null = null;

export function setPayoutToken(token: string): void {
  cachedPayoutToken = token;
}

export function getPayoutToken(): string | null {
  return cachedPayoutToken;
}

export function clearPayoutToken(): void {
  cachedPayoutToken = null;
}

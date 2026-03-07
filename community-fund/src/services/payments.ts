/**
 * Open Payments Service
 * Thin wrapper around the Open Payments Node SDK.
 * All other services interact with Open Payments through this module only.
 *
 * Handles both directions:
 *   INBOUND  - creating incoming payment resources for member contributions
 *   OUTBOUND - requesting grants and executing payouts to recipient wallets
 *
 * Docs: https://openpayments.dev
 */

import { createAuthenticatedClient, OpenPaymentsClientError, isPendingGrant, isFinalizedGrant } from "@interledger/open-payments";
import { config } from "../config";

let client: Awaited<ReturnType<typeof createAuthenticatedClient>>;

export function getClient() { return client; }

/**
 * Initializes the Open Payments authenticated client.
 * Must be called once at server startup before any payment operations.
 */
export async function initPaymentsClient(): Promise<void> {
  client = await createAuthenticatedClient({
    walletAddressUrl: config.openPayments.walletAddress,
    privateKey: config.openPayments.privateKeyPath,
    keyId: config.openPayments.keyId,
    validateResponses: false,
  });

  console.log("Open Payments client initialized.");
}

// ---------------------------------------------------------------------------
// INBOUND: Contributions from members into the fund
// ---------------------------------------------------------------------------

/**
 * Creates an incoming payment resource on the fund's wallet.
 * The returned URL is shared with the contributing member's wallet
 * to route their payment into the fund.
 */
export async function createIncomingPayment(params: {
  amount: number;
  currency: string;
  memberId: string;
}): Promise<{ incomingPaymentId: string; paymentUrl: string }> {
  const walletAddress = await client.walletAddress.get({
    url: config.openPayments.walletAddress,
  });

  // Request a non-interactive grant for incoming-payment on the fund wallet
  const grant = await client.grant.request(
    { url: walletAddress.authServer },
    {
      access_token: {
        access: [
          {
            type: "incoming-payment",
            actions: ["create", "read", "list"],
            identifier: config.openPayments.walletAddress,
          },
        ],
      },
    }
  );

  if (isPendingGrant(grant)) {
    throw new Error("Expected non-interactive grant for incoming payment.");
  }

  const incomingPayment = await client.incomingPayment.create(
    { url: walletAddress.resourceServer, accessToken: grant.access_token.value },
    {
      walletAddress: config.openPayments.walletAddress,
      incomingAmount: {
        value: String(params.amount),
        assetCode: walletAddress.assetCode,
        assetScale: walletAddress.assetScale,
      },
      metadata: { memberId: params.memberId },
    } as any
  );

  return {
    incomingPaymentId: incomingPayment.id,
    paymentUrl: incomingPayment.id,
  };
}

/**
 * Requests a recurring (non-interactive) grant from a member's wallet.
 * Used to set up automatic periodic contributions without per-payment consent.
 */
export async function requestRecurringContributionGrant(params: {
  memberWalletAddress: string;
  amount: number;
  currency: string;
  intervalSeconds: number;
}): Promise<{ grantId: string; continueUri: string; continueToken: string }> {
  const memberWallet = await client.walletAddress.get({
    url: params.memberWalletAddress,
  });

  const grant = await client.grant.request(
    { url: memberWallet.authServer },
    {
      access_token: {
        access: [
          {
            type: "outgoing-payment",
            actions: ["create", "read", "list"],
            identifier: params.memberWalletAddress,
            limits: {
              debitAmount: {
                value: String(params.amount),
                assetCode: params.currency,
                assetScale: 2,
              },
              interval: `R/${new Date().toISOString()}/PT${params.intervalSeconds}S`,
            },
          },
        ],
      },
      interact: {
        start: ["redirect"],
        finish: {
          method: "redirect",
          uri: `${config.openPayments.walletAddress}/grant-callback`,
          nonce: String(Date.now()),
        },
      },
    }
  );

  // Grant requires interactive redirect — return continue details to frontend
  if (!isPendingGrant(grant)) {
    throw new Error("Expected interactive grant response.");
  }

  return {
    grantId: grant.continue.uri,
    continueUri: grant.continue.uri,
    continueToken: grant.continue.access_token.value,
  };
}

// ---------------------------------------------------------------------------
// OUTBOUND: Payouts from the fund to recipient wallets
// ---------------------------------------------------------------------------

/**
 * Requests a non-interactive grant to send a payout from the fund wallet.
 * The fund wallet is the sender — no user interaction needed as the
 * fund manager key signs automatically.
 */
export async function requestPayoutGrant(params: {
  recipientWalletAddress: string;
  amount: number;
  currency: string;
}): Promise<{ accessToken: string; manageUrl: string }> {
  const fundWallet = await client.walletAddress.get({
    url: config.openPayments.walletAddress,
  });

  const grant = await client.grant.request(
    { url: fundWallet.authServer },
    {
      access_token: {
        access: [
          {
            type: "outgoing-payment",
            actions: ["create", "read"],
            identifier: config.openPayments.walletAddress,
            limits: {
              debitAmount: {
                value: String(params.amount),
                assetCode: params.currency,
                assetScale: 2,
              },
            },
          },
        ],
      },
    }
  );

  if (isPendingGrant(grant)) {
    throw new Error("Expected non-interactive grant — fund wallet requires interactive setup.");
  }

  return {
    accessToken: grant.access_token.value,
    manageUrl: grant.access_token.manage,
  };
}

/**
 * Creates an outgoing payment from the fund to a recipient wallet.
 * Should be called after requestPayoutGrant returns an access token.
 */
export async function executeOutgoingPayment(params: {
  recipientWalletAddress: string;
  incomingPaymentId: string;
  amount: number;
  currency: string;
  accessToken: string;
  metadata?: Record<string, string>;
}): Promise<{ outgoingPaymentId: string }> {
  const fundWallet = await client.walletAddress.get({
    url: config.openPayments.walletAddress,
  });

  const outgoingPayment = await client.outgoingPayment.create(
    {
      url: fundWallet.resourceServer,
      accessToken: params.accessToken,
    },
    {
      walletAddress: config.openPayments.walletAddress,
      incomingPayment: params.incomingPaymentId,
      debitAmount: {
        value: String(params.amount),
        assetCode: params.currency,
        assetScale: 2,
      },
      metadata: params.metadata,
    }
  );

  return { outgoingPaymentId: outgoingPayment.id };
}

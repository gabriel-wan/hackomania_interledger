/**
 * Interactive Contribution Routes
 * Implements the full Open Payments redirect flow:
 *
 *   1. POST /contribute/start   - Create incoming payment + request interactive grant
 *   2. GET  /contribute/callback - Handle redirect from user's wallet after approval
 *
 * The user is redirected to their ILP wallet to approve the payment,
 * then redirected back here. The callback completes the grant,
 * executes the outgoing payment, and redirects to the dashboard.
 */

import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { isPendingGrant, isFinalizedGrant } from "@interledger/open-payments";
import { config } from "../config";
import { createIncomingPayment, getClient } from "../services/payments";
import { getMemberByWallet, registerMember } from "../db/memberRegistry";
import { logEvent } from "../services/eventLog";
import { ch } from "../db/clickhouse";

// In-memory store for pending contributions (grant state between redirects)
const pendingGrants = new Map<string, {
  contributionId: string;
  memberId: string;
  amount: number;
  currency: string;
  incomingPaymentId: string;
  continueUri: string;
  continueAccessToken: string;
  senderWalletAddress: string;
  nonce: string;
  createdAt: number;
}>();

// Clean up stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingGrants) {
    if (now - val.createdAt > 30 * 60 * 1000) pendingGrants.delete(key);
  }
}, 10 * 60 * 1000);

export async function contributeRoutes(app: FastifyInstance): Promise<void> {

  /**
   * Step 1: User initiates a contribution.
   * Creates an incoming payment on the fund wallet, then requests an
   * interactive grant on the sender's wallet. Returns a redirect URL.
   */
  app.post<{
    Body: {
      senderWalletAddress: string;
      senderName: string;
      amount: number;
      currency?: string;
    };
  }>("/contribute/start", async (req, reply) => {
    const { senderWalletAddress, senderName, amount, currency = "USD" } = req.body;

    if (!senderWalletAddress || !amount) {
      return reply.status(400).send({ success: false, error: "Wallet address and amount required." });
    }

    const client = getClient();

    try {
      // Ensure sender is registered as a member
      let member = await getMemberByWallet(senderWalletAddress);
      if (!member) {
        member = await registerMember({
          walletAddress: senderWalletAddress,
          name: senderName || "Anonymous",
          email: "",
          location: "",
          latitude: 0,
          longitude: 0,
          consentGiven: true,
        });
      }

      // 1. Create incoming payment on the FUND wallet (to receive the money)
      const { incomingPaymentId } = await createIncomingPayment({
        amount,
        currency,
        memberId: member.id,
      });

      // 2. Get sender's wallet info
      const senderWallet = await client.walletAddress.get({
        url: senderWalletAddress,
      });

      // 3. Request interactive grant on sender's wallet
      const nonce = randomUUID();
      const callbackUrl = `http://localhost:${config.server.port}/contribute/callback`;

      const grant = await client.grant.request(
        { url: senderWallet.authServer },
        {
          access_token: {
            access: [
              {
                type: "quote",
                actions: ["create", "read"],
              },
              {
                type: "outgoing-payment",
                actions: ["create", "read"],
                identifier: senderWalletAddress,
                limits: {
                  debitAmount: {
                    value: String(amount),
                    assetCode: senderWallet.assetCode,
                    assetScale: senderWallet.assetScale,
                  },
                },
              },
            ],
          },
          interact: {
            start: ["redirect"],
            finish: {
              method: "redirect",
              uri: callbackUrl,
              nonce,
            },
          },
        }
      );

      if (!isPendingGrant(grant)) {
        return reply.status(500).send({
          success: false,
          error: "Expected interactive grant but wallet returned non-interactive response.",
        });
      }

      // 4. Store pending state for the callback
      const contributionId = randomUUID();
      pendingGrants.set(nonce, {
        contributionId,
        memberId: member.id,
        amount,
        currency,
        incomingPaymentId,
        continueUri: grant.continue.uri,
        continueAccessToken: grant.continue.access_token.value,
        senderWalletAddress,
        nonce,
        createdAt: Date.now(),
      });

      // 5. Return redirect URL — frontend will redirect the user here
      return reply.send({
        success: true,
        data: {
          redirectUrl: grant.interact.redirect,
          contributionId,
        },
      });

    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const message = err?.description ?? err?.message ?? "Unknown error";
      const details = err?.validationErrors ?? err?.response?.data ?? null;

      console.error("[Contribute] /contribute/start error:", {
        status,
        message,
        details,
        stack: err?.stack,
      });

      return reply.status(500).send({
        success: false,
        error: message,
        ...(details ? { details } : {}),
      });
    }
  });

  /**
   * Step 2: Callback after user approves the grant at their wallet.
   * Completes the grant, executes outgoing payment, records contribution,
   * and redirects back to the dashboard.
   */
  app.get<{
    Querystring: {
      interact_ref?: string;
      hash?: string;
      result?: string;
    };
  }>("/contribute/callback", async (req, reply) => {
    const { interact_ref, hash, result } = req.query;

    console.log(`[Contribute] Callback received: interact_ref=${interact_ref}, result=${result}, hash=${hash}`);
    console.log(`[Contribute] Pending grants count: ${pendingGrants.size}`);

    if (result === "grant_rejected" || !interact_ref) {
      return reply.redirect("/?error=grant_rejected");
    }

    // Find the most recent pending grant
    let pending: typeof pendingGrants extends Map<string, infer V> ? V : never;
    let pendingKey: string | undefined;

    for (const [key, val] of pendingGrants) {
      pendingKey = key;
      pending = val;
    }

    if (!pending! || !pendingKey) {
      console.error("[Contribute] No pending grants found - server may have restarted");
      return reply.redirect("/?error=no_pending_grant");
    }

    // Remove from pending
    pendingGrants.delete(pendingKey);

    console.log(`[Contribute] Found pending grant: contributionId=${pending.contributionId}, continueUri=${pending.continueUri}`);

    try {
      const client = getClient();

      // 1. Continue the grant to get the access token
      const continuation = await client.grant.continue(
        {
          url: pending.continueUri,
          accessToken: pending.continueAccessToken,
        },
        { interact_ref },
      );

      if (!isFinalizedGrant(continuation)) {
        return reply.redirect("/?error=grant_continuation_failed");
      }

      // 2. Get sender's wallet for resource server
      const senderWallet = await client.walletAddress.get({
        url: pending.senderWalletAddress,
      });

      console.log(`[Contribute] Sender wallet: assetCode=${senderWallet.assetCode}, assetScale=${senderWallet.assetScale}`);
      console.log(`[Contribute] Incoming payment ID: ${pending.incomingPaymentId}`);

      // 3. Create a quote first
      const quote = await client.quote.create(
        {
          url: senderWallet.resourceServer,
          accessToken: continuation.access_token.value,
        },
        {
          walletAddress: pending.senderWalletAddress,
          receiver: pending.incomingPaymentId,
          method: "ilp",
        } as any
      );

      console.log(`[Contribute] Quote created: ${quote.id}`);

      // 4. Execute outgoing payment using the quote
      const outgoingPayment = await client.outgoingPayment.create(
        {
          url: senderWallet.resourceServer,
          accessToken: continuation.access_token.value,
        },
        {
          walletAddress: pending.senderWalletAddress,
          quoteId: quote.id,
        } as any
      );

      // 4. Record the contribution
      const now = new Date().toISOString().replace("Z", "");
      await ch.insert({
        table: "contributions",
        values: [{
          id: pending.contributionId,
          member_id: pending.memberId,
          amount: pending.amount,
          currency: pending.currency,
          frequency: "one-off",
          op_grant_id: pending.continueUri,
          op_incoming_payment_id: pending.incomingPaymentId,
          status: "completed",
          created_at: now,
        }],
        format: "JSONEachRow",
      });

      await logEvent({
        type: "contribution_received",
        payload: {
          contributionId: pending.contributionId,
          memberId: pending.memberId,
          amount: pending.amount,
        },
        opTxId: outgoingPayment.id,
      });

      console.log(`[Contribute] Payment completed: ${pending.amount} ${pending.currency} from ${pending.senderWalletAddress}`);

      // 5. Redirect back to dashboard with success
      return reply.redirect(`/?contributed=${pending.amount}&currency=${pending.currency}`);

    } catch (err: any) {
      console.error("[Contribute] Callback error:", err);
      console.error("[Contribute] Error details:", err.description, err.validationErrors, err.status);
      return reply.redirect(`/?error=${encodeURIComponent(err.description || err.message || "payment_failed")}`);
    }
  });
}

/**
 * Admin Routes
 * Provides an endpoint to pre-authorize payout grants via interactive flow.
 *
 * The ILP test wallet requires interactive grants for outgoing payments.
 * An admin visits /admin/payout-auth-url, gets redirected to the wallet
 * to approve, and the callback caches the access token for future payouts.
 */

import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { isPendingGrant, isFinalizedGrant } from "@interledger/open-payments";
import { config } from "../config";
import { getClient } from "../services/payments";
import { setPayoutToken } from "../services/payoutAuth";

export async function adminRoutes(app: FastifyInstance): Promise<void> {

  /**
   * GET /admin/payout-auth-url
   * Requests an interactive grant on the fund wallet for outgoing payments.
   * Returns a redirect URL for the admin to approve payouts.
   */
  app.get("/admin/payout-auth-url", async (req, reply) => {
    const client = getClient();

    const fundWallet = await client.walletAddress.get({
      url: config.openPayments.walletAddress,
    });

    const nonce = randomUUID();
    const callbackUrl = `http://localhost:${config.server.port}/admin/payout-callback`;

    const grant = await client.grant.request(
      { url: fundWallet.authServer },
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
              identifier: config.openPayments.walletAddress,
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
      return reply.send({
        success: true,
        message: "Non-interactive grant received — token cached.",
        accessToken: grant.access_token.value,
      });
    }

    // Store continue info for callback
    app.decorate("_pendingPayoutGrant", {
      continueUri: grant.continue.uri,
      continueAccessToken: grant.continue.access_token.value,
      nonce,
    });

    return reply.send({
      success: true,
      redirectUrl: grant.interact.redirect,
      message: "Visit the redirectUrl to approve payout grants.",
    });
  });

  /**
   * GET /admin/payout-callback
   * Callback after admin approves the payout grant at the wallet.
   * Caches the access token for use by the rule engine.
   */
  app.get<{
    Querystring: { interact_ref?: string; hash?: string; result?: string };
  }>("/admin/payout-callback", async (req, reply) => {
    const { interact_ref, result } = req.query;

    if (result === "grant_rejected" || !interact_ref) {
      return reply.redirect("/?error=payout_grant_rejected");
    }

    const pending = (app as any)._pendingPayoutGrant;
    if (!pending) {
      return reply.redirect("/?error=no_pending_payout_grant");
    }

    const client = getClient();

    const continuation = await client.grant.continue(
      {
        url: pending.continueUri,
        accessToken: pending.continueAccessToken,
      },
      { interact_ref },
    );

    if (!isFinalizedGrant(continuation)) {
      return reply.redirect("/?error=payout_token_missing");
    }

    setPayoutToken(continuation.access_token.value);
    console.log("[Admin] Payout access token cached successfully.");
    return reply.redirect("/?message=payout_authorized");
  });
}

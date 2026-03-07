/**
 * Member Routes
 *
 * POST /members           - Register a new member (requires explicit consent)
 * GET  /members/:id       - Get member profile
 */

import { FastifyInstance } from "fastify";
import { registerMember, getMemberById } from "../db/memberRegistry";
import { logEvent } from "../services/eventLog";

export async function memberRoutes(app: FastifyInstance): Promise<void> {

  app.post<{
    Body: {
      walletAddress: string;
      name: string;
      email: string;
      location: string;
      consentGiven: boolean;
    };
  }>("/members", async (req, reply) => {
    const member = await registerMember(req.body);

    await logEvent({
      type: "member_registered",
      payload: { memberId: member.id, walletAddress: member.walletAddress },
      opTxId: null,
    });

    return reply.status(201).send({ success: true, data: member });
  });

  app.get<{ Params: { id: string } }>("/members/:id", async (req, reply) => {
    const member = await getMemberById(req.params.id);
    if (!member) {
      return reply.status(404).send({ success: false, error: "Member not found." });
    }
    return reply.send({ success: true, data: member });
  });
}

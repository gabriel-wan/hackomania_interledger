/**
 * Governance Routes
 *
 * POST /governance/proposals        - Submit a new rule/threshold proposal
 * GET  /governance/proposals        - List open proposals
 * GET  /governance/proposals/:id    - Get proposal detail
 * POST /governance/proposals/:id/vote - Cast a vote
 */

import { FastifyInstance } from "fastify";
import {
  createProposal,
  castVote,
  getOpenProposals,
  getProposalById,
} from "../services/governanceModule";
import { ApiResponse } from "../types";

export async function governanceRoutes(app: FastifyInstance): Promise<void> {

  app.post<{
    Body: {
      type: string;
      title: string;
      description: string;
      proposedBy: string;
      payload: object;
      expiresInHours?: number;
    };
  }>("/governance/proposals", async (req, reply) => {
    const proposal = createProposal(req.body as any);
    return reply.status(201).send({ success: true, data: proposal });
  });

  app.get("/governance/proposals", async (_req, reply) => {
    const proposals = getOpenProposals();
    return reply.send({ success: true, data: proposals });
  });

  app.get<{ Params: { id: string } }>(
    "/governance/proposals/:id",
    async (req, reply) => {
      const proposal = getProposalById(req.params.id);
      if (!proposal) {
        return reply.status(404).send({ success: false, error: "Proposal not found." });
      }
      return reply.send({ success: true, data: proposal });
    }
  );

  app.post<{
    Params: { id: string };
    Body: { memberId: string; choice: string };
  }>("/governance/proposals/:id/vote", async (req, reply) => {
    const vote = castVote({
      proposalId: req.params.id,
      memberId: req.body.memberId,
      choice: req.body.choice as any,
    });
    return reply.status(201).send({ success: true, data: vote });
  });
}

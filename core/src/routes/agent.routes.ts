import { Router, Request, Response, NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';
import { authAgent }    from '../mcp/auth.mcp';
import { kycAgent }     from '../mcp/kyc.mcp';
import { membersAgent } from '../mcp/members.mcp';
import { runOrchestrator, OrchestratorArgs } from '../agent/reasoning.service';
import { requireAuth }  from '../middleware/auth.middleware';

const router = Router();

// ── Helper: mount a McpServer at a path via stateless StreamableHTTP ──────────

function mountMcp(agent: typeof authAgent) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — each request is independent
    });
    res.on('close', () => { transport.close().catch(() => undefined); });
    try {
      await agent.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  };
}

// ── MCP endpoints ─────────────────────────────────────────────────────────────

router.post('/mcp/auth',    mountMcp(authAgent));
router.post('/mcp/kyc',     mountMcp(kycAgent));
router.post('/mcp/members', mountMcp(membersAgent));

// ── /agent/chat — rule-based orchestrator ────────────────────────────────────

router.post(
  '/agent/chat',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Wire format: { message } OR { tool, args: {...} }
      // The nested `args` must be unwrapped here — spreading req.body directly
      // leaves a literal `args` property instead of merging its contents, so
      // tool handlers reading top-level fields like applicationId get undefined.
      const { message = '', tool, args: bodyArgs } = req.body as {
        message?: string;
        tool?:    string;
        args?:    Record<string, unknown>;
      };

      const args: OrchestratorArgs = {
        ...(bodyArgs ?? {}),
        tool,
        userId: req.user?.sub,
        role:   req.user?.role,
        reviewerId:   req.user?.sub,
        reviewerRole: req.user?.role,
      };

      const result = await runOrchestrator(message, args);

      // If the tool result carries a refreshToken (auth flows via MCP), promote
      // it to an HttpOnly cookie so the browser session stays consistent.
      if (result.content.length > 0) {
        try {
          const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
          if (typeof parsed.refreshToken === 'string') {
            res.cookie('verikyc_rt', parsed.refreshToken, {
              httpOnly: true,
              secure:   process.env.NODE_ENV === 'production',
              sameSite: 'strict',
              path:     '/api/v1/auth',
              maxAge:   7 * 24 * 60 * 60 * 1000,
            });
            delete parsed.refreshToken;
            result.content[0].text = JSON.stringify(parsed);
          }
        } catch {
          // content is not JSON — leave it untouched
        }
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;

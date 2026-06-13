import { Router, Request, Response, NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';
import { authAgent }    from './auth.agent';
import { kycAgent }     from './kyc.agent';
import { membersAgent } from './members.agent';
import { runOrchestrator, OrchestratorArgs } from './orchestrator';
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
      const { message = '', ...rest } = req.body as { message?: string } & OrchestratorArgs;

      const args: OrchestratorArgs = {
        ...rest,
        userId: (req as Request & { user?: { id: string; role: string } }).user?.id,
        role:   (req as Request & { user?: { id: string; role: string } }).user?.role,
      };

      const result = await runOrchestrator(message, args);

      // If the tool result carries a refreshToken (auth flows via MCP), promote it
      // to an HttpOnly cookie so the browser session stays consistent.
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
          // content is not JSON (unexpected) — leave it untouched
        }
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;

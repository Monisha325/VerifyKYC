// ── LLM tool registry ──────────────────────────────────────────────────────────
// Derives OpenAI-compatible function-calling tool definitions from the exact
// same {description, schema} objects each agent file already registers on its
// MCP server (AUTH_TOOL_DEFS / KYC_TOOL_DEFS / MEMBERS_TOOL_DEFS) — the LLM
// upgrade spec explicitly calls for a single source of truth shared by both
// MCP and the LLM, not a second hand-written copy of every tool's schema.

import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod/v3';
import { AUTH_TOOL_DEFS }    from './auth.agent';
import { KYC_TOOL_DEFS }     from './kyc.agent';
import { MEMBERS_TOOL_DEFS } from './members.agent';

export type ToolDomain = 'auth' | 'kyc' | 'members';

export interface LlmToolDef {
  domain:      ToolDomain;
  name:        string;
  description: string;
  parameters:  Record<string, unknown>; // JSON Schema, OpenAI function-calling shape
}

// Fields the orchestrator already auto-injects from the verified session
// (agent.router.ts, from req.user.sub/role) — never expose these to the LLM.
// It has no way to know real values, and whatever it filled in would be
// overwritten by the real session values anyway once the tool actually runs.
const AUTO_INJECTED_FIELDS = new Set(['userId', 'role', 'reviewerId', 'reviewerRole']);

function toJsonSchema(schema: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const filtered: Record<string, z.ZodTypeAny> = {};
  for (const [key, val] of Object.entries(schema)) {
    if (!AUTO_INJECTED_FIELDS.has(key)) filtered[key] = val;
  }
  // zodToJsonSchema on a bare ZodObject returns the object schema itself
  // ({type, properties, required, ...}) — exactly the shape OpenAI's
  // `function.parameters` expects, no wrapping needed.
  return zodToJsonSchema(z.object(filtered)) as Record<string, unknown>;
}

function buildDefs(
  domain: ToolDomain,
  defs:   Record<string, { description: string; schema: Record<string, z.ZodTypeAny> }>,
): LlmToolDef[] {
  return Object.entries(defs).map(([name, def]) => ({
    domain,
    name,
    description: def.description,
    parameters:  toJsonSchema(def.schema),
  }));
}

// Deliberately NOT filtered by role — see llm.orchestrator.ts's header
// comment. The model sees every tool; dispatchTool's unconditional role
// check is what actually enforces RBAC, matching the spec's own example
// (an APPLICANT's model may attempt create_reviewer; the orchestrator
// rejects it for real either way).
export const LLM_TOOL_DEFS: LlmToolDef[] = [
  ...buildDefs('auth',    AUTH_TOOL_DEFS),
  ...buildDefs('kyc',     KYC_TOOL_DEFS),
  ...buildDefs('members', MEMBERS_TOOL_DEFS),
];

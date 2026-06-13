import { authTools }    from './auth.agent';
import { kycTools }     from './kyc.agent';
import { membersTools } from './members.agent';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

// ── Exact tool name dispatch (highest priority) ────────────────────────────────

const AUTH_TOOL_NAMES    = new Set(['register_user', 'login_user', 'verify_email', 'resend_otp', 'refresh_token', 'logout', 'get_current_user']);
const KYC_TOOL_NAMES     = new Set(['create_application', 'get_upload_params', 'register_document', 'submit_application', 'get_application_status', 'get_application', 'get_document', 'cancel_application']);
const MEMBERS_TOOL_NAMES = new Set(['get_review_queue', 'get_evidence_bundle', 'claim_application', 'submit_decision', 'get_audit_trail']);

// ── Keyword regex patterns (fallback for natural language messages) ────────────

const AUTH_PATTERNS = [
  /\b(register|sign[- ]?up|create[- ]?account)\b/i,
  /\b(login|log[- ]?in|sign[- ]?in|authenticate|password)\b/i,
  /\b(verify[- ]?email|otp|email[- ]?verification)\b/i,
  /\b(resend|otp|one[- ]?time[- ]?pass)\b/i,
  /\b(refresh[- ]?token|rotate[- ]?token)\b/i,
  /\b(logout|log[- ]?out|sign[- ]?out|revoke[- ]?session)\b/i,
  /\b(current[- ]?user|my[- ]?profile|who[- ]?am[- ]?i|my\s+account|my\s+info)\b/i,
];

const KYC_PATTERNS = [
  /\b(kyc|know[- ]?your[- ]?customer)\b/i,
  /\b(application|apply|start[- ]?kyc|create[- ]?app)\b/i,
  /\b(upload|document|aadhaar|pan|passport|driving[- ]?li[cs]ence|selfie)\b/i,
  /\b(register[- ]?doc|submit[- ]?doc|cloudinary)\b/i,
  /\b(submit[- ]?application|submit[- ]?kyc)\b/i,
  /\b(app[- ]?status|kyc[- ]?status|check[- ]?status|processing|score[- ]?band)\b/i,
  /\b(cancel[- ]?application|re[- ]?apply|rejected[- ]?kyc)\b/i,
];

const MEMBERS_PATTERNS = [
  /\b(review[- ]?queue|pending[- ]?review|applications[- ]?to[- ]?review)\b/i,
  /\b(evidence[- ]?bundle|full[- ]?evidence|review[- ]?bundle)\b/i,
  /\b(claim[- ]?application|take[- ]?case|assign[- ]?review)\b/i,
  /\b(submit[- ]?decision|approve|reject|escalate)\b/i,
  /\b(audit[- ]?trail|audit[- ]?history|audit[- ]?log|event[- ]?history)\b/i,
];

function scoreMessage(message: string, patterns: RegExp[]): number {
  return patterns.reduce((n, re) => n + (re.test(message) ? 1 : 0), 0);
}

function inferAgent(message: string): 'auth' | 'kyc' | 'members' {
  const authScore    = scoreMessage(message, AUTH_PATTERNS);
  const kycScore     = scoreMessage(message, KYC_PATTERNS);
  const membersScore = scoreMessage(message, MEMBERS_PATTERNS);

  if (authScore === 0 && kycScore === 0 && membersScore === 0) return 'kyc';

  if (authScore >= kycScore && authScore >= membersScore) return 'auth';
  if (membersScore > kycScore) return 'members';
  return 'kyc';
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface OrchestratorArgs {
  tool?:       string;
  userId?:     string;
  role?:       string;
  [key: string]: unknown;
}

export async function runOrchestrator(
  message:   string,
  args:      OrchestratorArgs,
): Promise<ToolResult> {
  const { tool, ...toolArgs } = args;

  // 1. Exact tool name supplied — dispatch immediately
  if (tool) {
    if (AUTH_TOOL_NAMES.has(tool))    return authTools[tool]?.(toolArgs)    ?? notFound(tool);
    if (KYC_TOOL_NAMES.has(tool))     return kycTools[tool]?.(toolArgs)     ?? notFound(tool);
    if (MEMBERS_TOOL_NAMES.has(tool)) return membersTools[tool]?.(toolArgs) ?? notFound(tool);
    return notFound(tool);
  }

  // 2. Natural language — keyword routing
  const agent = inferAgent(message);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        agent,
        message: `Routed to ${agent} agent. Provide a specific tool name via the "tool" field to execute an action.`,
        availableTools: agent === 'auth'
          ? [...AUTH_TOOL_NAMES]
          : agent === 'kyc'
            ? [...KYC_TOOL_NAMES]
            : [...MEMBERS_TOOL_NAMES],
      }),
    }],
  };
}

function notFound(tool: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Unknown tool: "${tool}"` }],
    isError: true,
  };
}

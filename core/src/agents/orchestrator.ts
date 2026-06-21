import { authTools }    from './auth.agent';
import { kycTools }     from './kyc.agent';
import { membersTools } from './members.agent';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

// ── Exact tool name dispatch (highest priority) ────────────────────────────────

const AUTH_TOOL_NAMES    = new Set(['register_user', 'login_user', 'verify_email', 'resend_otp', 'refresh_token', 'logout', 'get_current_user']);
const KYC_TOOL_NAMES     = new Set(['create_application', 'get_upload_params', 'register_document', 'submit_application', 'get_application_status', 'get_application', 'get_document', 'cancel_application']);
const MEMBERS_TOOL_NAMES = new Set(['get_review_queue', 'get_evidence_bundle', 'claim_application', 'submit_decision', 'get_audit_trail']);

// Human-readable labels for the tool-selection buttons shown in chat when a
// message is routed but not specific enough to dispatch automatically.
const TOOL_LABELS: Record<string, string> = {
  // auth
  register_user:          'Create an account',
  login_user:              'Log in',
  verify_email:            'Verify my email',
  resend_otp:              'Resend verification code',
  refresh_token:           'Refresh my session',
  logout:                  'Log out',
  get_current_user:        'View my profile',
  // kyc
  create_application:      'Start a new KYC application',
  get_upload_params:       'Get document upload link',
  register_document:       'Register an uploaded document',
  submit_application:      'Submit my application',
  get_application_status:  'Check my application status',
  get_application:         'View my full application',
  get_document:            'View a document',
  cancel_application:      'Cancel my application',
  // members
  get_review_queue:        'Show the review queue',
  get_evidence_bundle:     'View evidence bundle',
  claim_application:       'Claim this application',
  submit_decision:         'Submit a decision',
  get_audit_trail:         'View audit trail',
};

function toToolOptions(names: Iterable<string>) {
  return [...names].map(name => ({ name, label: TOOL_LABELS[name] ?? name }));
}

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

function inferAgent(message: string, role?: string): 'auth' | 'kyc' | 'members' {
  const authScore    = scoreMessage(message, AUTH_PATTERNS);
  const kycScore     = scoreMessage(message, KYC_PATTERNS);
  const membersScore = scoreMessage(message, MEMBERS_PATTERNS);

  // Role-aware default for ambiguous/unmatched messages. REVIEWER and ADMIN
  // have zero overlap with kyc-agent tools (see TOOLS_BY_ROLE in
  // AgentChat.tsx) — defaulting them to 'kyc' left them with a routing
  // message and no matching action buttons to click.
  const defaultAgent: 'kyc' | 'members' =
    role === 'REVIEWER' || role === 'ADMIN' ? 'members' : 'kyc';

  if (authScore === 0 && kycScore === 0 && membersScore === 0) return defaultAgent;

  if (authScore >= kycScore && authScore >= membersScore) return 'auth';
  if (kycScore === membersScore) return defaultAgent;
  return kycScore > membersScore ? 'kyc' : 'members';
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
  const agent = inferAgent(message, args.role);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        agent,
        message: `Routed to ${agent} agent. Provide a specific tool name via the "tool" field to execute an action.`,
        availableTools: agent === 'auth'
          ? toToolOptions(AUTH_TOOL_NAMES)
          : agent === 'kyc'
            ? toToolOptions(KYC_TOOL_NAMES)
            : toToolOptions(MEMBERS_TOOL_NAMES),
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

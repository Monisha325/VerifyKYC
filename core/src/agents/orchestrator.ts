import { authTools }    from './auth.agent';
import { kycTools }     from './kyc.agent';
import { membersTools } from './members.agent';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

// ── Exact tool name dispatch (highest priority) ────────────────────────────────

const AUTH_TOOL_NAMES    = new Set(['register_user', 'login_user', 'verify_email', 'resend_otp', 'refresh_token', 'logout', 'get_current_user', 'forgot_password', 'reset_password', 'change_password', 'update_profile']);
const KYC_TOOL_NAMES     = new Set(['create_application', 'get_upload_params', 'register_document', 'submit_application', 'get_application_status', 'get_application', 'get_document', 'cancel_application']);
const MEMBERS_TOOL_NAMES = new Set(['get_review_queue', 'get_evidence_bundle', 'claim_application', 'submit_decision', 'get_audit_trail', 'create_reviewer', 'disable_reviewer', 'enable_reviewer', 'list_users', 'manage_roles', 'system_audit_logs']);

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
  forgot_password:         'Forgot password',
  reset_password:          'Reset password',
  change_password:         'Change password',
  update_profile:          'Update my profile',
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
  // members — admin-only
  create_reviewer:         'Create a reviewer account',
  disable_reviewer:        'Disable a user account',
  enable_reviewer:         'Enable a user account',
  list_users:              'List all users',
  manage_roles:            "Change a user's role",
  system_audit_logs:       'View system-wide audit log',
};

// ── Role-based access control ─────────────────────────────────────────────────
// Mirrors the visibility table from the auth-agent system prompt spec. Checked
// in runOrchestrator before any tool is dispatched — this is real enforcement,
// not just which buttons the frontend shows. A role not listed for a tool gets
// "Access Denied: Insufficient Permissions" regardless of how the call arrives
// (exact tool name via chat, or any other caller of runOrchestrator).
const ADMIN_ONLY_MEMBERS_TOOLS = new Set(['create_reviewer', 'disable_reviewer', 'enable_reviewer', 'list_users', 'manage_roles', 'system_audit_logs']);

const TOOL_ROLE_ACCESS: Record<string, ReadonlySet<string>> = (() => {
  const allRoles = new Set(['APPLICANT', 'REVIEWER', 'ADMIN']);
  const map: Record<string, ReadonlySet<string>> = {};
  // Auth tools — every role gets the same set (spec: identical "Visible
  // Authentication Tools" list for APPLICANT/REVIEWER/ADMIN).
  for (const name of AUTH_TOOL_NAMES) map[name] = allRoles;
  // KYC tools — APPLICANT only (spec lists no "Visible KYC Tools" for
  // REVIEWER/ADMIN at all).
  for (const name of KYC_TOOL_NAMES) map[name] = new Set(['APPLICANT']);
  // Members tools — REVIEWER + ADMIN, except the admin-only subset.
  for (const name of MEMBERS_TOOL_NAMES) {
    map[name] = ADMIN_ONLY_MEMBERS_TOOLS.has(name) ? new Set(['ADMIN']) : new Set(['REVIEWER', 'ADMIN']);
  }
  return map;
})();

function isToolAllowedForRole(tool: string, role: string | undefined): boolean {
  const allowed = TOOL_ROLE_ACCESS[tool];
  if (!allowed) return false; // unknown tool — handled separately by notFound()
  return !!role && allowed.has(role);
}

function toToolOptions(names: Iterable<string>, role: string | undefined) {
  return [...names]
    .filter(name => isToolAllowedForRole(name, role))
    .map(name => ({ name, label: TOOL_LABELS[name] ?? name }));
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

// 'discovery' = no single domain clearly matched (generic greeting, "help",
// empty input, or a message that ties equally across domains) — the caller
// should see every tool their role can access, grouped by domain, rather
// than a guessed single agent. Replaces the old role-biased default (which
// silently picked 'kyc' or 'members' for ambiguous input) with an honest
// "I don't know which one you meant" response.
function inferAgent(message: string): 'auth' | 'kyc' | 'members' | 'discovery' {
  const authScore    = scoreMessage(message, AUTH_PATTERNS);
  const kycScore     = scoreMessage(message, KYC_PATTERNS);
  const membersScore = scoreMessage(message, MEMBERS_PATTERNS);

  const maxScore = Math.max(authScore, kycScore, membersScore);
  if (maxScore === 0) return 'discovery';

  const topCount = [authScore, kycScore, membersScore].filter(s => s === maxScore).length;
  if (topCount > 1) return 'discovery'; // genuine tie — not clearly one domain over another

  if (authScore === maxScore) return 'auth';
  return kycScore === maxScore ? 'kyc' : 'members';
}

// ── Tool discovery — all tools the role can access, grouped by domain ────────

const DOMAIN_LABELS = { auth: 'AUTHENTICATION', kyc: 'KYC', members: 'MEMBERS' } as const;

function buildDiscoveryGroups(role: string | undefined) {
  const groups: { domain: keyof typeof DOMAIN_LABELS; label: string; tools: { name: string; label: string }[] }[] = [];
  for (const [domain, names] of [
    ['auth',    AUTH_TOOL_NAMES]    as const,
    ['kyc',     KYC_TOOL_NAMES]     as const,
    ['members', MEMBERS_TOOL_NAMES] as const,
  ]) {
    const tools = toToolOptions(names, role);
    // Omitting empty groups is what keeps this aligned with
    // TOOL_ROLE_ACCESS — e.g. APPLICANT's members group is always empty
    // (no members tool is ever allowed for APPLICANT) and so never appears.
    if (tools.length > 0) groups.push({ domain, label: DOMAIN_LABELS[domain], tools });
  }
  return groups;
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

  // 1. Exact tool name supplied — dispatch immediately, after a role check.
  if (tool) {
    if (!AUTH_TOOL_NAMES.has(tool) && !KYC_TOOL_NAMES.has(tool) && !MEMBERS_TOOL_NAMES.has(tool)) {
      return notFound(tool);
    }
    if (!isToolAllowedForRole(tool, args.role)) {
      return accessDenied();
    }
    if (AUTH_TOOL_NAMES.has(tool))    return authTools[tool]?.(toolArgs)    ?? notFound(tool);
    if (KYC_TOOL_NAMES.has(tool))     return kycTools[tool]?.(toolArgs)     ?? notFound(tool);
    return membersTools[tool]?.(toolArgs) ?? notFound(tool);
  }

  // 2. Natural language — keyword routing
  const agent = inferAgent(message);

  if (agent === 'discovery') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          agent: 'discovery',
          message: 'Here\'s everything you can do — click any action below, or type a specific request.',
          toolGroups: buildDiscoveryGroups(args.role),
        }),
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        agent,
        message: `Routed to ${agent} agent. Provide a specific tool name via the "tool" field to execute an action.`,
        availableTools: agent === 'auth'
          ? toToolOptions(AUTH_TOOL_NAMES, args.role)
          : agent === 'kyc'
            ? toToolOptions(KYC_TOOL_NAMES, args.role)
            : toToolOptions(MEMBERS_TOOL_NAMES, args.role),
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

function accessDenied(): ToolResult {
  return {
    content: [{ type: 'text', text: 'Access Denied: Insufficient Permissions' }],
    isError: true,
  };
}

// ── Shared tool dispatch — the single real enforcement + execution path ──────
// Used by both orchestrator.ts (exact tool-name calls, e.g. button clicks)
// and llm.orchestrator.ts (tool calls the LLM decides to make). Neither of
// those two files imports the other — both depend on this one instead — so
// there's no circular import between "the orchestrator that can call the
// LLM" and "the LLM layer that calls back into tool execution."

import { authTools }    from './auth.agent';
import { kycTools }     from './kyc.agent';
import { membersTools } from './members.agent';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

export const AUTH_TOOL_NAMES    = new Set(['register_user', 'login_user', 'verify_email', 'resend_otp', 'refresh_token', 'logout', 'get_current_user', 'forgot_password', 'reset_password', 'change_password', 'update_profile']);
export const KYC_TOOL_NAMES     = new Set(['create_application', 'get_upload_params', 'register_document', 'submit_application', 'get_application_status', 'get_application', 'get_document', 'cancel_application']);
export const MEMBERS_TOOL_NAMES = new Set(['get_review_queue', 'get_evidence_bundle', 'claim_application', 'submit_decision', 'get_audit_trail', 'create_reviewer', 'disable_reviewer', 'enable_reviewer', 'list_users', 'manage_roles', 'system_audit_logs']);

// Human-readable labels — used for chat's exact-tool-name routing response
// (existing behavior, unchanged) and available for any other caller that
// wants a display label for a tool name.
export const TOOL_LABELS: Record<string, string> = {
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
// Mirrors the visibility table from the auth-agent system prompt spec. This
// is real enforcement, checked before any tool runs — regardless of whether
// the call arrived as an exact tool name (button click), via the LLM's own
// tool selection, or any other future caller of dispatchTool.
const ADMIN_ONLY_MEMBERS_TOOLS = new Set(['create_reviewer', 'disable_reviewer', 'enable_reviewer', 'list_users', 'manage_roles', 'system_audit_logs']);

export const TOOL_ROLE_ACCESS: Record<string, ReadonlySet<string>> = (() => {
  const allRoles = new Set(['APPLICANT', 'REVIEWER', 'ADMIN']);
  const map: Record<string, ReadonlySet<string>> = {};
  for (const name of AUTH_TOOL_NAMES) map[name] = allRoles;
  for (const name of KYC_TOOL_NAMES) map[name] = new Set(['APPLICANT']);
  for (const name of MEMBERS_TOOL_NAMES) {
    map[name] = ADMIN_ONLY_MEMBERS_TOOLS.has(name) ? new Set(['ADMIN']) : new Set(['REVIEWER', 'ADMIN']);
  }
  return map;
})();

export function isToolAllowedForRole(tool: string, role: string | undefined): boolean {
  const allowed = TOOL_ROLE_ACCESS[tool];
  if (!allowed) return false; // unknown tool — handled separately by notFound()
  return !!role && allowed.has(role);
}

export function toToolOptions(names: Iterable<string>, role: string | undefined) {
  return [...names]
    .filter(name => isToolAllowedForRole(name, role))
    .map(name => ({ name, label: TOOL_LABELS[name] ?? name }));
}

export function notFound(tool: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Unknown tool: "${tool}"` }],
    isError: true,
  };
}

export function accessDenied(): ToolResult {
  return {
    content: [{ type: 'text', text: 'Access Denied: Insufficient Permissions' }],
    isError: true,
  };
}

// The single real execution path — role check, then dispatch to the actual
// tool implementation. Both orchestrator.ts's exact-tool-name branch and
// llm.orchestrator.ts's tool-calling loop call this and only this.
export async function dispatchTool(
  tool:     string,
  toolArgs: Record<string, unknown>,
  role:     string | undefined,
): Promise<ToolResult> {
  if (!AUTH_TOOL_NAMES.has(tool) && !KYC_TOOL_NAMES.has(tool) && !MEMBERS_TOOL_NAMES.has(tool)) {
    return notFound(tool);
  }
  if (!isToolAllowedForRole(tool, role)) {
    return accessDenied();
  }
  if (AUTH_TOOL_NAMES.has(tool))    return authTools[tool]?.(toolArgs)    ?? notFound(tool);
  if (KYC_TOOL_NAMES.has(tool))     return kycTools[tool]?.(toolArgs)     ?? notFound(tool);
  return membersTools[tool]?.(toolArgs) ?? notFound(tool);
}

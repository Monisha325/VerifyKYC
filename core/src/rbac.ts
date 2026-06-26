// ── RBAC + tool dispatch — the single real enforcement + execution path ────────
// Used by both reasoning.service.ts (Path A: exact tool name) and
// supervisor.ts (Path B: LLM tool calls). Neither of those two files
// imports the other — both depend on this one, so there is no circular import.

import { authTools }    from './agent/agents';
import { kycTools }     from './agent/agents';
import { membersTools } from './agent/agents';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

export const AUTH_TOOL_NAMES    = new Set(['register_user', 'login_user', 'verify_email', 'resend_otp', 'refresh_token', 'logout', 'get_current_user', 'forgot_password', 'reset_password', 'change_password', 'update_profile']);
export const KYC_TOOL_NAMES     = new Set(['create_application', 'get_upload_params', 'register_document', 'submit_application', 'get_application_status', 'get_application', 'get_document', 'cancel_application']);
export const MEMBERS_TOOL_NAMES = new Set(['get_review_queue', 'get_evidence_bundle', 'claim_application', 'submit_decision', 'get_audit_trail', 'create_reviewer', 'disable_reviewer', 'enable_reviewer', 'list_users', 'manage_roles', 'system_audit_logs']);

export const TOOL_LABELS: Record<string, string> = {
  register_user: 'Create an account', login_user: 'Log in', verify_email: 'Verify my email',
  resend_otp: 'Resend verification code', refresh_token: 'Refresh my session', logout: 'Log out',
  get_current_user: 'View my profile', forgot_password: 'Forgot password', reset_password: 'Reset password',
  change_password: 'Change password', update_profile: 'Update my profile',
  create_application: 'Start a new KYC application', get_upload_params: 'Get document upload link',
  register_document: 'Register an uploaded document', submit_application: 'Submit my application',
  get_application_status: 'Check my application status', get_application: 'View my full application',
  get_document: 'View a document', cancel_application: 'Cancel my application',
  get_review_queue: 'Show the review queue', get_evidence_bundle: 'View evidence bundle',
  claim_application: 'Claim this application', submit_decision: 'Submit a decision',
  get_audit_trail: 'View audit trail', create_reviewer: 'Create a reviewer account',
  disable_reviewer: 'Disable a user account', enable_reviewer: 'Enable a user account',
  list_users: 'List all users', manage_roles: "Change a user's role",
  system_audit_logs: 'View system-wide audit log',
};

const ADMIN_ONLY = new Set(['create_reviewer', 'disable_reviewer', 'enable_reviewer', 'list_users', 'manage_roles', 'system_audit_logs']);

export const TOOL_ROLE_ACCESS: Record<string, ReadonlySet<string>> = (() => {
  const all  = new Set(['APPLICANT', 'REVIEWER', 'ADMIN']);
  const map: Record<string, ReadonlySet<string>> = {};
  for (const name of AUTH_TOOL_NAMES)    map[name] = all;
  for (const name of KYC_TOOL_NAMES)     map[name] = new Set(['APPLICANT']);
  for (const name of MEMBERS_TOOL_NAMES) map[name] = ADMIN_ONLY.has(name) ? new Set(['ADMIN']) : new Set(['REVIEWER', 'ADMIN']);
  return map;
})();

export function isToolAllowedForRole(tool: string, role: string | undefined): boolean {
  const allowed = TOOL_ROLE_ACCESS[tool];
  return !!allowed && !!role && allowed.has(role);
}

export function toToolOptions(names: Iterable<string>, role: string | undefined) {
  return [...names].filter(n => isToolAllowedForRole(n, role)).map(n => ({ name: n, label: TOOL_LABELS[n] ?? n }));
}

export function notFound(tool: string): ToolResult {
  return { content: [{ type: 'text', text: `Unknown tool: "${tool}"` }], isError: true };
}

export function accessDenied(): ToolResult {
  return { content: [{ type: 'text', text: 'Access Denied: Insufficient Permissions' }], isError: true };
}

export async function dispatchTool(tool: string, toolArgs: Record<string, unknown>, role: string | undefined): Promise<ToolResult> {
  if (!AUTH_TOOL_NAMES.has(tool) && !KYC_TOOL_NAMES.has(tool) && !MEMBERS_TOOL_NAMES.has(tool)) return notFound(tool);
  if (!isToolAllowedForRole(tool, role)) return accessDenied();
  if (AUTH_TOOL_NAMES.has(tool))    return authTools[tool]?.(toolArgs)    ?? notFound(tool);
  if (KYC_TOOL_NAMES.has(tool))     return kycTools[tool]?.(toolArgs)     ?? notFound(tool);
  return membersTools[tool]?.(toolArgs) ?? notFound(tool);
}

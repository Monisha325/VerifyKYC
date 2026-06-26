'use client';

import { useEffect, useRef, useState } from 'react';
import { Send, Loader2, Bot, User, AlertCircle, X, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useApplication } from '@/context/ApplicationContext';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { cn } from '@/lib/utils';

interface AgentResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'agent' | 'error' | 'system';
  raw: string;
  parsed?: Record<string, unknown>;
  isError?: boolean;
}

export default function AgentChat() {
  const { user } = useAuth();
  const { loading: appLoading } = useApplication();
  const allowedTools = TOOLS_BY_ROLE[user?.role ?? 'APPLICANT'] ?? TOOLS_BY_ROLE.APPLICANT;
  const [messages, setMessages] = useState<Message[]>([{
    id: 'welcome',
    role: 'system',
    raw: "Hi! I'm your VeriKYC assistant. Ask about your application status, submit documents, or check the review queue.",
  }]);
  const [input, setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const [passwordModalTool, setPasswordModalTool] = useState<'change_password' | 'create_reviewer' | null>(null);
  const bottomRef       = useRef<HTMLDivElement>(null);
  const textareaRef     = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Posts to /agent/chat and appends the response as an agent/error bubble.
  // No user bubble — used both by sendPayload (which adds one beforehand)
  // and the silent on-mount discovery fetch (which should not look like the
  // user typed anything).
  async function fetchAndAppend(payload: Record<string, unknown>) {
    setLoading(true);
    try {
      const { data } = await api.post<AgentResponse>('/agent/chat', payload);
      const rawText = data.content?.[0]?.text ?? '';
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(rawText); } catch { /* plain text */ }

      setMessages(prev => [...prev, {
        id:      `a-${Date.now()}`,
        role:    data.isError ? 'error' : 'agent',
        raw:     rawText,
        parsed,
        isError: data.isError,
      }]);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      setMessages(prev => [...prev, {
        id:   `e-${Date.now()}`,
        role: 'error',
        raw:  status === 401
          ? 'Session expired — please sign in again.'
          : 'Could not reach the server. Check your connection and try again.',
      }]);
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
    }
  }

  async function sendPayload(body: Record<string, unknown>, displayText: string) {
    setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', raw: displayText }]);
    await fetchAndAppend(body);
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    await sendPayload({ message: text }, text);
  }

  // Path A: direct tool execution via a button click — bypasses the LLM
  // entirely, goes straight to the orchestrator via sendPayload's exact
  // {tool, args} shape. Path B (the textarea → send()) goes through the LLM
  // instead. Both end up at the same dispatchTool() on the backend.
  async function sendTool(toolName: string) {
    if (loading) return;

    // Passwords need masked input — window.prompt() (used below for
    // everything else) shows plaintext on screen while typing, which is
    // fine for an application ID but not for a password.
    if (toolName === 'change_password' || toolName === 'create_reviewer') {
      setPasswordModalTool(toolName);
      return;
    }

    if (toolName === 'manage_roles') {
      const targetUserId = window.prompt('User ID whose role you want to change:')?.trim();
      if (!targetUserId) return;
      const newRole = window.prompt('New role (APPLICANT, REVIEWER, or ADMIN):')?.trim().toUpperCase();
      if (!newRole || !['APPLICANT', 'REVIEWER', 'ADMIN'].includes(newRole)) {
        if (newRole) window.alert(`"${newRole}" is not a valid role. Must be APPLICANT, REVIEWER, or ADMIN.`);
        return;
      }
      await sendPayload({ tool: toolName, args: { targetUserId, newRole } }, `manage_roles (${targetUserId} -> ${newRole})`);
      return;
    }

    // Two optional fields, neither sensitive — sequential prompts, skipping
    // whichever one the user leaves blank/cancels.
    if (toolName === 'update_profile') {
      const fullName = window.prompt('New full name (leave blank to keep unchanged):')?.trim();
      const phone    = window.prompt('New phone number (leave blank to keep unchanged):')?.trim();
      if (!fullName && !phone) return;
      await sendPayload(
        { tool: toolName, args: { ...(fullName && { fullName }), ...(phone && { phone }) } },
        'update_profile',
      );
      return;
    }

    // These tools need one id/value the chat has no existing context for —
    // prompt for it before calling.
    const promptCfg = TOOL_ARG_PROMPTS[toolName];
    if (promptCfg) {
      const value = window.prompt(promptCfg.label)?.trim();
      if (!value) return;
      await sendPayload(
        { tool: toolName, args: { ...promptCfg.extraArgs, [promptCfg.argKey]: value } },
        `${toolName} (${value})`,
      );
      return;
    }

    await sendPayload({ tool: toolName, args: {} }, TOOL_LABELS[toolName] ?? toolName);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  return (
    <div className="animate-fade-up flex flex-col h-[calc(100vh-8rem)]">

      <div className="mb-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Agent Chat</h1>
          {appLoading && <span className="text-xs text-gray-400">Loading context…</span>}
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Click an action below, or just ask the assistant in plain language — both do the same thing.
        </p>
      </div>

      {/* Quick Actions — Path A: direct tool execution, no LLM involved */}
      <QuickActions allowedTools={allowedTools} onTool={sendTool} disabled={loading} />

      {/* Messages */}
      <Card className="flex-1 min-h-0 overflow-y-auto mb-3" padding={false}>
        <div className="p-4 space-y-4">
          {messages.map(msg => <Bubble key={msg.id} msg={msg} />)}

          {loading && (
            <div className="flex items-start gap-3">
              <BotAvatar />
              <div className="flex items-center gap-2 px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-50 border border-gray-100">
                <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                <span className="text-sm text-gray-400">Thinking…</span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </Card>

      {/* Input */}
      <div className="flex gap-2 items-end flex-shrink-0">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => { setInput(e.target.value); autoResize(e.target); }}
          onKeyDown={onKeyDown}
          placeholder="e.g. 'What is my application status?' or 'Show the review queue'"
          rows={1}
          disabled={loading}
          className={cn(
            'flex-1 resize-none rounded-xl border border-gray-200 bg-white px-4 py-3',
            'text-sm text-gray-900 placeholder:text-gray-400 transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-brand-navy/20 focus:border-brand-navy',
            'disabled:opacity-50 min-h-[46px] max-h-[120px]',
          )}
        />
        <Button
          onClick={send}
          disabled={!input.trim() || loading}
          loading={loading}
          className="flex-shrink-0 !px-3.5 h-[46px]"
          aria-label="Send"
        >
          <Send className="w-4 h-4" />
        </Button>
      </div>

      <p className="text-xs text-gray-400 text-center mt-2 flex-shrink-0">
        Enter to send · Shift+Enter for new line
      </p>

      {passwordModalTool && (
        <PasswordModal
          tool={passwordModalTool}
          onClose={() => setPasswordModalTool(null)}
          onSubmit={async (args) => {
            setPasswordModalTool(null);
            await sendPayload({ tool: passwordModalTool, args }, TOOL_LABELS[passwordModalTool] ?? passwordModalTool);
          }}
        />
      )}
    </div>
  );
}

// ── Password modal — masked input for the two tools with a password field ───
// Everything else can go through the conversational textbox and let the LLM
// pick the tool and arguments — but a password typed into that box would be
// sent in plaintext as part of the chat message, so these two stay outside
// the LLM flow entirely and call the tool directly via sendPayload.

function PasswordModal({
  tool, onClose, onSubmit,
}: {
  tool:     'change_password' | 'create_reviewer';
  onClose:  () => void;
  onSubmit: (args: Record<string, string>) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword,     setNewPassword]     = useState(''); // also used as create_reviewer's password field
  const [email,           setEmail]           = useState('');
  const [fullName,        setFullName]        = useState('');
  const [phone,           setPhone]           = useState('');
  const [error,           setError]           = useState('');

  function submit() {
    if (tool === 'create_reviewer') {
      if (!email.trim())    { setError('Email is required.'); return; }
      if (!fullName.trim()) { setError('Full name is required.'); return; }
      if (newPassword.length < 8) { setError('Password must be at least 8 characters.'); return; }
      onSubmit({ email: email.trim(), fullName: fullName.trim(), password: newPassword, ...(phone.trim() && { phone: phone.trim() }) });
      return;
    }
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (!currentPassword) { setError('Current password is required.'); return; }
    onSubmit({ currentPassword, newPassword });
  }

  const title = tool === 'change_password' ? 'Change password' : 'Create reviewer account';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <Card className="w-full max-w-sm relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-600"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
        <h2 className="text-base font-semibold text-gray-900 mb-4">{title}</h2>
        <div className="space-y-3">
          {tool === 'create_reviewer' && (
            <>
              <Input type="email" label="Email" value={email} onChange={e => setEmail(e.target.value)} autoFocus />
              <Input type="text" label="Full name" value={fullName} onChange={e => setFullName(e.target.value)} />
              <Input type="text" label="Phone (optional)" value={phone} onChange={e => setPhone(e.target.value)} />
            </>
          )}
          {tool === 'change_password' && (
            <Input
              type="password"
              label="Current password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              autoFocus
            />
          )}
          <Input
            type="password"
            label={tool === 'create_reviewer' ? 'Password' : 'New password'}
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            hint="At least 8 characters"
          />
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit}>Submit</Button>
        </div>
      </Card>
    </div>
  );
}

// ── Quick Actions — Path A, direct tool buttons (no LLM involved) ────────────
// Per-role allowlists, restricted to tools with no better dedicated page —
// get_review_queue/get_evidence_bundle/claim_application/submit_decision/
// get_audit_trail are deliberately NOT here: /admin/queue, /admin/[id], and
// /admin/audit already do those with a richer UI (image previews, score
// gauges, a real decision form, a search box) than a button ever could.
// Server-side RBAC (dispatchTool) is what actually enforces this either way
// — these lists only decide what's worth a button, never what's allowed.
const TOOLS_BY_ROLE: Record<string, Set<string>> = {
  APPLICANT: new Set([
    'create_application',
    'get_application_status',
    'get_application',
    'get_current_user',
    'forgot_password',
    'update_profile',
    'change_password',
  ]),
  REVIEWER: new Set([
    'get_current_user',
    'forgot_password',
    'update_profile',
    'change_password',
    'get_review_queue',
    'get_evidence_bundle',
    'claim_application',
    'submit_decision',
    'get_audit_trail',
  ]),
  ADMIN: new Set([
    'get_current_user',
    'forgot_password',
    'update_profile',
    'change_password',
    'list_users',
    'system_audit_logs',
    'disable_reviewer',
    'enable_reviewer',
    'manage_roles',
    'create_reviewer',
  ]),
};

const TOOL_LABELS: Record<string, string> = {
  get_current_user:       'View my profile',
  forgot_password:        'Forgot password',
  update_profile:         'Update my profile',
  change_password:        'Change password',
  create_application:     'Start a new KYC application',
  get_application_status: 'Check my application status',
  get_application:        'View my full application',
  get_review_queue:       'Show review queue',
  get_evidence_bundle:    'View evidence bundle',
  claim_application:      'Claim application',
  submit_decision:        'Submit decision',
  get_audit_trail:        'View audit trail',
  list_users:             'List all users',
  system_audit_logs:      'View system-wide audit log',
  disable_reviewer:       'Disable a user account',
  enable_reviewer:        'Enable a user account',
  manage_roles:           "Change a user's role",
  create_reviewer:        'Create a reviewer account',
};

const TOOL_DOMAINS: { label: string; tools: string[] }[] = [
  { label: 'AUTHENTICATION', tools: ['get_current_user', 'forgot_password', 'update_profile', 'change_password'] },
  { label: 'KYC AGENT',      tools: ['create_application', 'get_application_status', 'get_application'] },
  { label: 'MEMBERS',        tools: ['get_review_queue', 'get_evidence_bundle', 'claim_application', 'submit_decision', 'get_audit_trail', 'list_users', 'system_audit_logs', 'disable_reviewer', 'enable_reviewer', 'manage_roles', 'create_reviewer'] },
];

// Tools whose one missing argument is collected via a prompt on click,
// rather than auto-injected context.
const TOOL_ARG_PROMPTS: Record<string, { label: string; argKey: string; extraArgs?: Record<string, unknown> }> = {
  forgot_password:     { label: 'Email address to send the password reset link to:', argKey: 'email' },
  disable_reviewer:    { label: 'User ID to disable:',                               argKey: 'targetUserId' },
  enable_reviewer:     { label: 'User ID to re-enable:',                             argKey: 'targetUserId' },
  get_evidence_bundle: { label: 'Application ID to view evidence for:',              argKey: 'applicationId' },
  claim_application:   { label: 'Application ID to claim:',                          argKey: 'applicationId' },
  submit_decision:     { label: 'Application ID to submit a decision for:',          argKey: 'applicationId' },
  get_audit_trail:     { label: 'Application ID to view audit trail for:',           argKey: 'applicationId' },
};

function QuickActions({ allowedTools, onTool, disabled }: { allowedTools: Set<string>; onTool: (tool: string) => void; disabled: boolean }) {
  const groups = TOOL_DOMAINS
    .map(g => ({ ...g, tools: g.tools.filter(t => allowedTools.has(t)) }))
    .filter(g => g.tools.length > 0);

  if (groups.length === 0) return null;

  return (
    <Card className="mb-3 flex-shrink-0" padding={false}>
      <div className="p-3 space-y-2.5">
        {groups.map(g => (
          <div key={g.label} className="flex flex-wrap items-center gap-1.5">
            <span className="flex items-center gap-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider shrink-0 min-w-max">
              <Wrench className="w-3 h-3" />
              {g.label}
            </span>
            {g.tools.map(t => (
              <button
                key={t}
                type="button"
                onClick={() => !disabled && onTool(t)}
                disabled={disabled}
                className={cn(
                  'px-2.5 py-1 rounded-lg bg-brand-navy/5 text-brand-navy text-xs font-medium transition-all',
                  disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-brand-navy/15 active:scale-95 cursor-pointer',
                )}
              >
                {TOOL_LABELS[t] ?? t}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Avatars ───────────────────────────────────────────────────────────────────

function BotAvatar() {
  return (
    <div className="w-8 h-8 rounded-full bg-brand-navy/10 flex items-center justify-center flex-shrink-0 mt-0.5">
      <Bot className="w-4 h-4 text-brand-navy" />
    </div>
  );
}

function UserAvatar() {
  return (
    <div className="w-8 h-8 rounded-full bg-brand-navy flex items-center justify-center flex-shrink-0 mt-0.5">
      <User className="w-4 h-4 text-white" />
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: Message }) {
  if (msg.role === 'user') {
    return (
      <div className="flex items-start gap-3 justify-end">
        <div className="max-w-[80%] px-4 py-3 rounded-2xl rounded-tr-sm bg-brand-navy text-white text-sm whitespace-pre-wrap">
          {msg.raw}
        </div>
        <UserAvatar />
      </div>
    );
  }

  if (msg.role === 'system') {
    return (
      <div className="flex items-start gap-3">
        <BotAvatar />
        <div className="max-w-[80%] px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-50 border border-gray-100 text-sm text-gray-500 italic">
          {msg.raw}
        </div>
      </div>
    );
  }

  if (msg.role === 'error') {
    return (
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-rose-100 flex items-center justify-center flex-shrink-0 mt-0.5">
          <AlertCircle className="w-4 h-4 text-rose-500" />
        </div>
        <div className="max-w-[80%] px-4 py-3 rounded-2xl rounded-tl-sm bg-rose-50 border border-rose-200 text-sm text-rose-700">
          {msg.raw}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <BotAvatar />
      <AgentContent msg={msg} />
    </div>
  );
}

// ── Agent message content (routing vs tool result vs plain text) ───────────────

function AgentContent({ msg }: { msg: Message }) {
  const { parsed, raw } = msg;

  // Structured JSON result — pretty-print
  if (parsed && typeof parsed === 'object') {
    return (
      <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-50 border border-gray-100">
        <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words font-mono leading-relaxed overflow-x-auto">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      </div>
    );
  }

  // Plain text fallback
  return (
    <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-50 border border-gray-100 text-sm text-gray-700 whitespace-pre-wrap">
      {raw}
    </div>
  );
}

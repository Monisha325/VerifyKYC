// ── LLM agent layer — natural-language reasoning in front of the orchestrator ─
// Interprets a free-text message, selects a tool (or none, or several in
// sequence), and returns a conversational response. Every actual tool call
// it makes goes through dispatchTool() — the exact same execution +
// role-check path used for button clicks — so this layer can never bypass
// RBAC. It also never touches Prisma or any service function directly.
//
// Provider: Google Gemini, via the current @google/genai SDK (the older
// @google/generative-ai package is in maintenance mode — deliberately not
// used). Tool schemas come straight from llm.registry.ts's JSON Schema
// output via FunctionDeclaration.parametersJsonSchema, which accepts raw
// JSON Schema directly — no separate Gemini-specific schema format needed.
//
// Tools are exposed to the model unfiltered by role (see LLM_TOOL_DEFS)
// deliberately: the security boundary is dispatchTool's unconditional role
// check, not "hide the button" — an APPLICANT's model can still attempt
// create_reviewer if asked, and dispatchTool rejects it for real, the same
// way it would for a forged direct API call. Hiding tools from the model
// would only be a UX nicety layered on top, never the enforcement itself.

import { GoogleGenAI, ApiError, type Content, type Part, type FunctionDeclaration, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { LLM_TOOL_DEFS } from './llm.registry';
import { dispatchTool, type ToolResult } from './tool.dispatch';

const MODEL           = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_TOOL_ROUNDS = 6; // safety cap against runaway multi-step chains

// Gemini's free tier returns 503 ("model overloaded") and 429 ("quota
// exceeded") fairly often under real load — both are transient, and a
// short retry clears most of them without the user ever seeing an error.
const RETRYABLE_STATUS = new Set([429, 503]);
const MAX_RETRIES      = 2;
const RETRY_DELAY_MS   = 1500;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function generateWithRetry(client: GoogleGenAI, params: GenerateContentParameters): Promise<GenerateContentResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.models.generateContent(params);
    } catch (e: unknown) {
      const status = e instanceof ApiError ? e.status : undefined;
      if (attempt >= MAX_RETRIES || !status || !RETRYABLE_STATUS.has(status)) throw e;
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

let _client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _client;
}

const FUNCTION_DECLARATIONS: FunctionDeclaration[] = LLM_TOOL_DEFS.map(def => ({
  name:                 def.name,
  description:          `[${def.domain}] ${def.description}`,
  parametersJsonSchema: def.parameters,
}));

function systemPrompt(role: string | undefined): string {
  return `You are the VeriKYC assistant, helping with identity verification (KYC), account/authentication actions, and — for reviewers and admins — application review and user management.

The current user's role is ${role ?? 'APPLICANT'}. Tools are organized into three domains:
- auth: registration, login, profile, password management — available to every role.
- kyc: starting and tracking a KYC application, document upload/registration — APPLICANT only.
- members: review queue, evidence, decisions, audit trail, and (ADMIN only) user management — REVIEWER and ADMIN only.

Call a tool whenever the user's request maps to one. You do not need to ask the user for their own user ID, role, or reviewer ID — the system supplies these automatically from their authenticated session; never ask for them and never invent one.

If a request is outside the current role's permissions (for example an APPLICANT asking for an admin action), you may still attempt the tool call if asked directly — the system enforces permissions independently and will reject it — but it's more helpful to explain the limitation directly when it's obvious, rather than spending a turn on a call you can predict will be denied.

For multi-step requests (e.g. "help me complete my KYC"), call tools one at a time, look at each result, and decide the next step yourself — check status, create what's missing, proceed in logical order — rather than asking the user to do each step manually.

After tool calls, summarize the outcome conversationally in plain language — don't just repeat raw JSON back at the user.`;
}

export async function runLlmAgent(
  message:        string,
  sessionContext:  Record<string, unknown>, // userId/role/reviewerId/reviewerRole — auto-injected upstream from the verified session, never from the LLM
  role:            string | undefined,
): Promise<ToolResult> {
  const client = getClient();
  if (!client) {
    return {
      content: [{
        type: 'text',
        text: 'The conversational assistant is not configured (missing GEMINI_API_KEY). Provide a specific tool name via the "tool" field to execute an action directly.',
      }],
      isError: true,
    };
  }

  const contents: Content[] = [{ role: 'user', parts: [{ text: message }] }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response: GenerateContentResponse;
    try {
      response = await generateWithRetry(client, {
        model: MODEL,
        contents,
        config: {
          systemInstruction: systemPrompt(role),
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        },
      });
    } catch (e: unknown) {
      const status = e instanceof ApiError ? e.status : undefined;
      const text = status && RETRYABLE_STATUS.has(status)
        ? "The assistant is under heavy load right now and couldn't respond after a few retries. Please try again in a moment."
        : `Assistant temporarily unavailable: ${e instanceof Error ? e.message : String(e)}`;
      return { content: [{ type: 'text', text }], isError: true };
    }

    const candidateParts = response.candidates?.[0]?.content?.parts ?? [];
    contents.push({ role: 'model', parts: candidateParts });

    const functionCalls = response.functionCalls ?? [];
    if (functionCalls.length === 0) {
      // No more tool calls — this is the model's final conversational answer.
      return { content: [{ type: 'text', text: response.text ?? '' }] };
    }

    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      if (!call.name) continue; // malformed call from the model — nothing to dispatch

      // sessionContext spread LAST — the model's own arguments can never
      // override the real userId/role/reviewerId/reviewerRole.
      const result = await dispatchTool(call.name, { ...(call.args ?? {}), ...sessionContext }, role);
      const resultText = result.content[0]?.text ?? '';

      responseParts.push({
        functionResponse: {
          id:       call.id,
          name:     call.name,
          response: { result: resultText },
        },
      });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return {
    content: [{
      type: 'text',
      text: "I wasn't able to finish that within a reasonable number of steps. Could you rephrase the request or break it into smaller steps?",
    }],
    isError: true,
  };
}

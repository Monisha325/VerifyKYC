// ── LLM agent layer — LangGraph supervisor + 3 specialist sub-agents ──────────
//
// PRIMARY PATH (ANTHROPIC_API_KEY set):
//   LangGraph supervisor (claude-sonnet-4-6) routes to one of three ReAct
//   sub-agents (Auth / KYC / Members). Each sub-agent runs its own tool-calling
//   loop, then returns a summary. Tools call dispatchTool() — the same RBAC
//   enforcement path used by direct button clicks — so the LLM layer can
//   never bypass role checks.
//
//   Graph topology:
//     __start__ → supervisor
//     supervisor →(conditional)→ auth_agent | kyc_agent | members_agent | __end__
//     *_agent → supervisor   (results feed back for multi-step / final synthesis)
//
// FALLBACK PATH (only GEMINI_API_KEY set):
//   Original single-loop Gemini agent. No behaviour change for existing
//   production deployments until ANTHROPIC_API_KEY is added to Render.
//
// External signature is unchanged:
//   runLlmAgent(message, sessionContext, role) → Promise<ToolResult>
//
// Session fields (userId, role, reviewerId, reviewerRole) travel via
// LangGraph's configurable context — the LLM never sees or supplies them.

import { StateGraph, MessagesAnnotation }       from '@langchain/langgraph';
import { ChatAnthropic }                         from '@langchain/anthropic';
import { DynamicStructuredTool }                 from '@langchain/core/tools';
import { AIMessage, HumanMessage, ToolMessage,
         type BaseMessage }                      from '@langchain/core/messages';
import type { RunnableConfig }                   from '@langchain/core/runnables';
import { z }                                     from 'zod';
import { authLcTools, kycLcTools, membersLcTools } from './langchain.tools';

// Gemini fallback imports — only used when ANTHROPIC_API_KEY is absent.
import { GoogleGenAI, ApiError,
  type Content, type Part, type FunctionDeclaration,
  type GenerateContentParameters,
  type GenerateContentResponse } from '@google/genai';
import { LLM_TOOL_DEFS }         from './llm.registry';
import { dispatchTool, type ToolResult } from './tool.dispatch';

// ── Constants ─────────────────────────────────────────────────────────────────

const ANTHROPIC_MODEL  = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const GEMINI_MODEL     = process.env.GEMINI_MODEL    || 'gemini-2.5-flash';
const MAX_AGENT_ROUNDS = 8;   // sub-agent tool-call rounds
const MAX_TOOL_ROUNDS  = 6;   // Gemini fallback rounds

// ── Supervisor routing tools ──────────────────────────────────────────────────
// The supervisor calls one of these to hand off work to a specialist.
// Their func bodies are never executed — routing is driven by conditional
// edges that inspect the AIMessage tool_calls returned by the supervisor.

const transferToAuth = new DynamicStructuredTool({
  name:        'transfer_to_auth',
  description: 'Transfer to the Authentication agent for account, login, password, and profile tasks.',
  schema:       z.object({ task: z.string().describe('Specific task for the Authentication agent') }),
  func: async () => 'routed',
});

const transferToKYC = new DynamicStructuredTool({
  name:        'transfer_to_kyc',
  description: 'Transfer to the KYC agent for application creation, document upload, and verification status tasks.',
  schema:       z.object({ task: z.string().describe('Specific task for the KYC agent') }),
  func: async () => 'routed',
});

const transferToMembers = new DynamicStructuredTool({
  name:        'transfer_to_members',
  description: 'Transfer to the Members agent for review queue, decisions, audit trail, and (ADMIN) user management tasks.',
  schema:       z.object({ task: z.string().describe('Specific task for the Members agent') }),
  func: async () => 'routed',
});

// ── Prompts ───────────────────────────────────────────────────────────────────

function supervisorPrompt(ctx: Record<string, unknown>): string {
  return `You are the VeriKYC supervisor assistant. Understand the user's request and route it to the right specialist agent.

Current user role: ${ctx?.role ?? 'APPLICANT'}

Routing rules:
- Authentication — account, login, password, profile, email verification → transfer_to_auth
- KYC — application creation, document upload, status, cancellation → transfer_to_kyc
- Members — review queue, evidence, decisions, audit trail, user management → transfer_to_members

For multi-domain requests, route to each domain in sequence (one transfer at a time), then synthesize results into a single conversational answer.

Authorization is enforced server-side — route any request; the platform rejects unauthorized operations itself.

When all specialist work is done, respond conversationally in plain language without repeating raw JSON.`;
}

function subAgentPrompt(domain: string): string {
  return `You are the VeriKYC ${domain} specialist. Complete the delegated task using your tools, then provide a clear summary of the outcome.`;
}

// ── Sub-agent ReAct loop ──────────────────────────────────────────────────────
// Implements the same tool-calling loop as createReactAgent from
// @langchain/langgraph/prebuilt — bound tools, iterate until no more calls.

async function runSubAgent(
  tools:   DynamicStructuredTool[],
  domain:  string,
  task:    string,
  config:  RunnableConfig,
): Promise<string> {
  const llm      = new ChatAnthropic({ model: ANTHROPIC_MODEL }).bindTools(tools);
  const messages: BaseMessage[] = [
    new HumanMessage(task),
  ];

  // Build a quick tool-lookup map for execution.
  const toolMap = Object.fromEntries(tools.map(t => [t.name, t]));

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    const response = await llm.invoke(
      [{ role: 'system', content: subAgentPrompt(domain) }, ...messages],
      config,
    ) as AIMessage;
    messages.push(response);

    const calls = response.tool_calls ?? [];
    if (calls.length === 0) {
      // No more tool calls — return final text.
      return typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
    }

    // Execute each tool call and feed results back.
    for (const call of calls) {
      const tool   = toolMap[call.name];
      const result = tool
        ? await tool.invoke(call.args as Record<string, unknown>, config)
        : `Unknown tool: ${call.name}`;
      messages.push(new ToolMessage({
        content:      String(result),
        tool_call_id: call.id ?? call.name,
        name:         call.name,
      }));
    }
  }

  return "Couldn't complete the task within the allowed number of steps.";
}

// ── LangGraph node factories ──────────────────────────────────────────────────

function makeSubAgentNode(
  tools:            DynamicStructuredTool[],
  domain:           string,
  transferToolName: string,
) {
  return async (
    state:  typeof MessagesAnnotation.State,
    config: RunnableConfig,
  ): Promise<Partial<typeof MessagesAnnotation.State>> => {
    const last     = state.messages[state.messages.length - 1] as AIMessage;
    const transfer = last.tool_calls?.find(c => c.name === transferToolName);
    const task     = (transfer?.args as Record<string, string>)?.task ?? 'Complete the requested task.';

    const summary = await runSubAgent(tools, domain, task, config);

    return {
      messages: [
        new ToolMessage({
          content:      summary,
          tool_call_id: transfer?.id ?? `${transferToolName}_${Date.now()}`,
          name:         transferToolName,
        }),
      ],
    };
  };
}

// ── Graph assembly ────────────────────────────────────────────────────────────

function routeFromSupervisor(state: typeof MessagesAnnotation.State): string {
  const last = state.messages[state.messages.length - 1] as AIMessage;
  const call = last.tool_calls?.[0];
  if (!call) return '__end__';
  const routes: Record<string, string> = {
    transfer_to_auth:    'auth_agent',
    transfer_to_kyc:     'kyc_agent',
    transfer_to_members: 'members_agent',
  };
  return routes[call.name] ?? '__end__';
}

let _graph: ReturnType<typeof buildGraph> | null = null;

function buildGraph() {
  const supervisorLLM = new ChatAnthropic({ model: ANTHROPIC_MODEL })
    .bindTools([transferToAuth, transferToKYC, transferToMembers]);

  async function supervisorNode(
    state:  typeof MessagesAnnotation.State,
    config: RunnableConfig,
  ): Promise<Partial<typeof MessagesAnnotation.State>> {
    const response = await supervisorLLM.invoke(
      [
        { role: 'system', content: supervisorPrompt(config.configurable ?? {}) },
        ...state.messages,
      ],
      config,
    ) as AIMessage;
    return { messages: [response] };
  }

  return new StateGraph(MessagesAnnotation)
    .addNode('supervisor',    supervisorNode)
    .addNode('auth_agent',    makeSubAgentNode(authLcTools,    'Authentication', 'transfer_to_auth'))
    .addNode('kyc_agent',     makeSubAgentNode(kycLcTools,     'KYC',           'transfer_to_kyc'))
    .addNode('members_agent', makeSubAgentNode(membersLcTools, 'Members',       'transfer_to_members'))
    .addEdge('__start__', 'supervisor')
    .addConditionalEdges('supervisor', routeFromSupervisor, {
      auth_agent:    'auth_agent',
      kyc_agent:     'kyc_agent',
      members_agent: 'members_agent',
      __end__:       '__end__',
    })
    .addEdge('auth_agent',    'supervisor')
    .addEdge('kyc_agent',     'supervisor')
    .addEdge('members_agent', 'supervisor')
    .compile();
}

function getGraph() {
  if (!_graph) _graph = buildGraph();
  return _graph;
}

// ── LangGraph primary path ────────────────────────────────────────────────────

async function runLangGraphAgent(
  message:        string,
  sessionContext: Record<string, unknown>,
  role:           string | undefined,
): Promise<ToolResult> {
  try {
    const result  = await getGraph().invoke(
      { messages: [new HumanMessage(message)] },
      {
        configurable:   { ...sessionContext, role },
        recursionLimit: 30,
      },
    );

    const lastMsg = result.messages[result.messages.length - 1];
    const text    = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : JSON.stringify(lastMsg.content);

    return { content: [{ type: 'text', text }] };
  } catch (e: unknown) {
    const text = `Assistant temporarily unavailable: ${e instanceof Error ? e.message : String(e)}`;
    return { content: [{ type: 'text', text }], isError: true };
  }
}

// ── Gemini fallback path (original implementation, unchanged) ─────────────────

const RETRYABLE_STATUS = new Set([429, 503]);
const MAX_RETRIES      = 2;
const RETRY_DELAY_MS   = 1500;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function generateWithRetry(
  client: GoogleGenAI,
  params: GenerateContentParameters,
): Promise<GenerateContentResponse> {
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

let _geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_geminiClient) _geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _geminiClient;
}

const GEMINI_FUNCTION_DECLARATIONS: FunctionDeclaration[] = LLM_TOOL_DEFS.map(def => ({
  name:                 def.name,
  description:          `[${def.domain}] ${def.description}`,
  parametersJsonSchema: def.parameters,
}));

function geminiSystemPrompt(role: string | undefined): string {
  return `You are the VeriKYC assistant, helping with identity verification (KYC), account/authentication actions, and — for reviewers and admins — application review and user management.

The current user's role is ${role ?? 'APPLICANT'}. Tools are organized into three domains:
- auth: registration, login, profile, password management — available to every role.
- kyc: starting and tracking a KYC application, document upload/registration — APPLICANT only.
- members: review queue, evidence, decisions, audit trail, and (ADMIN only) user management — REVIEWER and ADMIN only.

Call a tool whenever the user's request maps to one. Never ask for the user's own userId, role, or reviewerId — the system supplies these from their authenticated session.

For multi-step requests, call tools one at a time, examine each result, then decide the next step.

After tool calls, summarize the outcome conversationally in plain language.`;
}

async function runGeminiAgent(
  message:        string,
  sessionContext: Record<string, unknown>,
  role:           string | undefined,
): Promise<ToolResult> {
  const client = getGeminiClient();
  if (!client) {
    return {
      content: [{ type: 'text', text: 'The conversational assistant is not configured. Set ANTHROPIC_API_KEY (recommended) or GEMINI_API_KEY, then redeploy.' }],
      isError: true,
    };
  }

  const contents: Content[] = [{ role: 'user', parts: [{ text: message }] }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response: GenerateContentResponse;
    try {
      response = await generateWithRetry(client, {
        model:    GEMINI_MODEL,
        contents,
        config: {
          systemInstruction: geminiSystemPrompt(role),
          tools: [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }],
        },
      });
    } catch (e: unknown) {
      const status = e instanceof ApiError ? e.status : undefined;
      const text   = status && RETRYABLE_STATUS.has(status)
        ? "The assistant is under heavy load right now and couldn't respond after a few retries. Please try again in a moment."
        : `Assistant temporarily unavailable: ${e instanceof Error ? e.message : String(e)}`;
      return { content: [{ type: 'text', text }], isError: true };
    }

    const candidateParts = response.candidates?.[0]?.content?.parts ?? [];
    contents.push({ role: 'model', parts: candidateParts });

    const functionCalls = response.functionCalls ?? [];
    if (functionCalls.length === 0) {
      return { content: [{ type: 'text', text: response.text ?? '' }] };
    }

    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      if (!call.name) continue;
      // sessionContext spread LAST — model args can never override real userId/role.
      const result = await dispatchTool(call.name, { ...(call.args ?? {}), ...sessionContext }, role);
      responseParts.push({
        functionResponse: {
          id:       call.id,
          name:     call.name,
          response: { result: result.content[0]?.text ?? '' },
        },
      });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return {
    content: [{ type: 'text', text: "I wasn't able to finish that within a reasonable number of steps. Could you rephrase the request or break it into smaller steps?" }],
    isError: true,
  };
}

// ── Public export — called by orchestrator.ts for Path B (free-text) ──────────

export async function runLlmAgent(
  message:        string,
  sessionContext: Record<string, unknown>,
  role:           string | undefined,
): Promise<ToolResult> {
  if (process.env.ANTHROPIC_API_KEY) {
    return runLangGraphAgent(message, sessionContext, role);
  }
  return runGeminiAgent(message, sessionContext, role);
}

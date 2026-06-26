// ── LangGraph supervisor + sub-agents + Gemini fallback ───────────────────────
//
// PRIMARY PATH (ANTHROPIC_API_KEY set):
//   Supervisor (claude-sonnet-4-6) routes to one of three ReAct sub-agents.
//   Each sub-agent runs a tool-calling loop; tools call dispatchTool() which
//   enforces RBAC — the LLM layer can never bypass role checks.
//
// FALLBACK PATH (only GEMINI_API_KEY set):
//   Original single-loop Gemini agent, unchanged.
//
// External signature:
//   runLlmAgent(message, sessionContext, role) → Promise<ToolResult>

import { StateGraph, MessagesAnnotation }        from '@langchain/langgraph';
import { ChatAnthropic }                          from '@langchain/anthropic';
import { DynamicStructuredTool }                  from '@langchain/core/tools';
import { AIMessage, HumanMessage, ToolMessage,
         type BaseMessage }                       from '@langchain/core/messages';
import type { RunnableConfig }                    from '@langchain/core/runnables';
import { z }                                      from 'zod';
import { zodToJsonSchema }                        from 'zod-to-json-schema';
import { z as zv3 }                               from 'zod/v3';
import { authLcTools, kycLcTools, membersLcTools } from './tools';
import { supervisorPrompt, subAgentPrompt, geminiSystemPrompt } from './prompts';
import { AUTH_TOOL_DEFS, KYC_TOOL_DEFS, MEMBERS_TOOL_DEFS }    from './agents';
import { dispatchTool, type ToolResult }          from '../rbac';
import { GoogleGenAI, ApiError,
  type Content, type Part, type FunctionDeclaration,
  type GenerateContentParameters,
  type GenerateContentResponse } from '@google/genai';

const ANTHROPIC_MODEL  = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const GEMINI_MODEL     = process.env.GEMINI_MODEL    || 'gemini-2.5-flash';
const MAX_AGENT_ROUNDS = 8;
const MAX_TOOL_ROUNDS  = 6;

// ── LangGraph ─────────────────────────────────────────────────────────────────

const transferToAuth = new DynamicStructuredTool({
  name: 'transfer_to_auth', description: 'Transfer to the Authentication agent.',
  schema: z.object({ task: z.string() }), func: async () => 'routed',
});
const transferToKYC = new DynamicStructuredTool({
  name: 'transfer_to_kyc', description: 'Transfer to the KYC agent.',
  schema: z.object({ task: z.string() }), func: async () => 'routed',
});
const transferToMembers = new DynamicStructuredTool({
  name: 'transfer_to_members', description: 'Transfer to the Members agent.',
  schema: z.object({ task: z.string() }), func: async () => 'routed',
});

async function runSubAgent(
  tools: DynamicStructuredTool[], domain: string, task: string, config: RunnableConfig,
): Promise<string> {
  const llm      = new ChatAnthropic({ model: ANTHROPIC_MODEL }).bindTools(tools);
  const messages: BaseMessage[] = [new HumanMessage(task)];
  const toolMap  = Object.fromEntries(tools.map(t => [t.name, t]));

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    const response = await llm.invoke(
      [{ role: 'system', content: subAgentPrompt(domain) }, ...messages], config,
    ) as AIMessage;
    messages.push(response);

    const calls = response.tool_calls ?? [];
    if (calls.length === 0) {
      return typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    }
    for (const call of calls) {
      const tool   = toolMap[call.name];
      const result = tool ? await tool.invoke(call.args as Record<string, unknown>, config) : `Unknown tool: ${call.name}`;
      messages.push(new ToolMessage({ content: String(result), tool_call_id: call.id ?? call.name, name: call.name }));
    }
  }
  return "Couldn't complete the task within the allowed number of steps.";
}

function makeSubAgentNode(tools: DynamicStructuredTool[], domain: string, transferToolName: string) {
  return async (state: typeof MessagesAnnotation.State, config: RunnableConfig): Promise<Partial<typeof MessagesAnnotation.State>> => {
    const last     = state.messages[state.messages.length - 1] as AIMessage;
    const transfer = last.tool_calls?.find(c => c.name === transferToolName);
    const task     = (transfer?.args as Record<string, string>)?.task ?? 'Complete the requested task.';
    const summary  = await runSubAgent(tools, domain, task, config);
    return {
      messages: [new ToolMessage({ content: summary, tool_call_id: transfer?.id ?? `${transferToolName}_${Date.now()}`, name: transferToolName })],
    };
  };
}

function routeFromSupervisor(state: typeof MessagesAnnotation.State): string {
  const last = state.messages[state.messages.length - 1] as AIMessage;
  const call = last.tool_calls?.[0];
  if (!call) return '__end__';
  return { transfer_to_auth: 'auth_agent', transfer_to_kyc: 'kyc_agent', transfer_to_members: 'members_agent' }[call.name] ?? '__end__';
}

let _graph: ReturnType<typeof buildGraph> | null = null;

function buildGraph() {
  const supervisorLLM = new ChatAnthropic({ model: ANTHROPIC_MODEL })
    .bindTools([transferToAuth, transferToKYC, transferToMembers]);

  async function supervisorNode(state: typeof MessagesAnnotation.State, config: RunnableConfig): Promise<Partial<typeof MessagesAnnotation.State>> {
    const response = await supervisorLLM.invoke(
      [{ role: 'system', content: supervisorPrompt(config.configurable ?? {}) }, ...state.messages], config,
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
      auth_agent: 'auth_agent', kyc_agent: 'kyc_agent', members_agent: 'members_agent', __end__: '__end__',
    })
    .addEdge('auth_agent', 'supervisor')
    .addEdge('kyc_agent',  'supervisor')
    .addEdge('members_agent', 'supervisor')
    .compile();
}

async function runLangGraphAgent(message: string, sessionContext: Record<string, unknown>, role: string | undefined): Promise<ToolResult> {
  try {
    if (!_graph) _graph = buildGraph();
    const result  = await _graph.invoke(
      { messages: [new HumanMessage(message)] },
      { configurable: { ...sessionContext, role }, recursionLimit: 30 },
    );
    const lastMsg = result.messages[result.messages.length - 1];
    const text    = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
    return { content: [{ type: 'text', text }] };
  } catch (e: unknown) {
    return { content: [{ type: 'text', text: `Assistant temporarily unavailable: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

// ── Gemini fallback — LLM tool registry inlined (was llm.registry.ts) ─────────

const AUTO_INJECTED = new Set(['userId', 'role', 'reviewerId', 'reviewerRole']);

function toJsonSchema(schema: Record<string, zv3.ZodTypeAny>): Record<string, unknown> {
  const filtered: Record<string, zv3.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!AUTO_INJECTED.has(k)) filtered[k] = v;
  }
  return zodToJsonSchema(zv3.object(filtered)) as Record<string, unknown>;
}

const GEMINI_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  ...Object.entries(AUTH_TOOL_DEFS).map(([name, def]) => ({ name, description: `[auth] ${def.description}`, parametersJsonSchema: toJsonSchema(def.schema) })),
  ...Object.entries(KYC_TOOL_DEFS).map(([name, def]) => ({ name, description: `[kyc] ${def.description}`, parametersJsonSchema: toJsonSchema(def.schema) })),
  ...Object.entries(MEMBERS_TOOL_DEFS).map(([name, def]) => ({ name, description: `[members] ${def.description}`, parametersJsonSchema: toJsonSchema(def.schema) })),
];

const RETRYABLE = new Set([429, 503]);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function generateWithRetry(client: GoogleGenAI, params: GenerateContentParameters): Promise<GenerateContentResponse> {
  for (let attempt = 0; ; attempt++) {
    try { return await client.models.generateContent(params); }
    catch (e: unknown) {
      const status = e instanceof ApiError ? e.status : undefined;
      if (attempt >= 2 || !status || !RETRYABLE.has(status)) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
}

let _geminiClient: GoogleGenAI | null = null;
function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_geminiClient) _geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _geminiClient;
}

async function runGeminiAgent(message: string, sessionContext: Record<string, unknown>, role: string | undefined): Promise<ToolResult> {
  const client = getGeminiClient();
  if (!client) {
    return { content: [{ type: 'text', text: 'The conversational assistant is not configured. Set ANTHROPIC_API_KEY (recommended) or GEMINI_API_KEY, then redeploy.' }], isError: true };
  }

  const contents: Content[] = [{ role: 'user', parts: [{ text: message }] }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response: GenerateContentResponse;
    try {
      response = await generateWithRetry(client, {
        model: GEMINI_MODEL, contents,
        config: { systemInstruction: geminiSystemPrompt(role), tools: [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }] },
      });
    } catch (e: unknown) {
      const status = e instanceof ApiError ? e.status : undefined;
      const text = status && RETRYABLE.has(status)
        ? "The assistant is under heavy load right now. Please try again in a moment."
        : `Assistant temporarily unavailable: ${e instanceof Error ? e.message : String(e)}`;
      return { content: [{ type: 'text', text }], isError: true };
    }

    const candidateParts = response.candidates?.[0]?.content?.parts ?? [];
    contents.push({ role: 'model', parts: candidateParts });

    const functionCalls = response.functionCalls ?? [];
    if (functionCalls.length === 0) return { content: [{ type: 'text', text: response.text ?? '' }] };

    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      if (!call.name) continue;
      const result = await dispatchTool(call.name, { ...(call.args ?? {}), ...sessionContext }, role);
      responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { result: result.content[0]?.text ?? '' } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return { content: [{ type: 'text', text: "I wasn't able to finish that within a reasonable number of steps. Could you rephrase or break it into smaller steps?" }], isError: true };
}

// ── Public export ─────────────────────────────────────────────────────────────

export async function runLlmAgent(message: string, sessionContext: Record<string, unknown>, role: string | undefined): Promise<ToolResult> {
  if (process.env.ANTHROPIC_API_KEY) return runLangGraphAgent(message, sessionContext, role);
  return runGeminiAgent(message, sessionContext, role);
}

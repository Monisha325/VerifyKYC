// ── Orchestrator — single source of truth for tool execution + permissions ───
// Exact tool name supplied (e.g. a button click) → dispatch directly, after
// a role check. No tool name (free-text message) → hand off to the LLM
// agent layer, which reasons about intent, selects a tool, and calls back
// into dispatchTool() for actual execution — the same enforcement path,
// every time, regardless of which agent picked the tool.

import { dispatchTool, type ToolResult } from './tool.dispatch';
import { runLlmAgent } from './llm.orchestrator';

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
    return dispatchTool(tool, toolArgs, args.role);
  }

  // 2. Natural language — the LLM decides intent, picks a tool (or asks a
  // clarifying question, or just answers conversationally), and any tool
  // call it makes is executed via the exact same dispatchTool() as above.
  // toolArgs already carries userId/role/reviewerId/reviewerRole (injected
  // upstream in agent.router.ts from the verified session) — passed through
  // so tool calls made inside the LLM's own loop have the same auto-filled
  // identity fields a direct button click would.
  return runLlmAgent(message, toolArgs, args.role);
}

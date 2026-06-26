// ── AgentReasoningService — single entry point for all tool + LLM calls ───────
// Path A (tool name supplied): exact tool → dispatchTool() → RBAC + execution
// Path B (free text): → runLlmAgent() → LangGraph supervisor (or Gemini fallback)
//
// Both paths enforce RBAC via dispatchTool(); the LLM layer never bypasses it.

import { dispatchTool, type ToolResult } from '../rbac';
import { runLlmAgent } from './supervisor';

export interface OrchestratorArgs {
  tool?:   string;
  userId?: string;
  role?:   string;
  [key: string]: unknown;
}

export async function runOrchestrator(message: string, args: OrchestratorArgs): Promise<ToolResult> {
  const { tool, ...toolArgs } = args;
  if (tool) return dispatchTool(tool, toolArgs, args.role);
  return runLlmAgent(message, toolArgs, args.role);
}

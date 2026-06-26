import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { kycTools, KYC_TOOL_DEFS } from '../agent/agents';

export const kycAgent = new McpServer({ name: 'kyc-agent', version: '1.0.0' });

for (const [name, def] of Object.entries(KYC_TOOL_DEFS)) {
  kycAgent.tool(name, def.description, def.schema, (args) => kycTools[name]!(args));
}

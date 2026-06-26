import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { authTools, AUTH_TOOL_DEFS } from '../agent/agents';

export const authAgent = new McpServer({ name: 'auth-agent', version: '1.0.0' });

for (const [name, def] of Object.entries(AUTH_TOOL_DEFS)) {
  authAgent.tool(name, def.description, def.schema, (args) => authTools[name]!(args));
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { membersTools, MEMBERS_TOOL_DEFS } from '../agent/agents';

export const membersAgent = new McpServer({ name: 'members-agent', version: '1.0.0' });

for (const [name, def] of Object.entries(MEMBERS_TOOL_DEFS)) {
  membersAgent.tool(name, def.description, def.schema, (args) => membersTools[name]!(args));
}

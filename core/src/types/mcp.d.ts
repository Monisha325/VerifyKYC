// Minimal ambient type shim for @modelcontextprotocol/sdk subpath imports.
// TypeScript's moduleResolution:node does not read package exports maps, so it
// cannot find the SDK's CJS declaration files via the subpath specifiers.
// The runtime path patch in register-mcp-paths.ts handles actual module
// loading; this file only gives the type-checker enough information to
// compile the agent files without errors.

declare module '@modelcontextprotocol/sdk/server/mcp' {
  export class McpServer {
    constructor(options: { name: string; version: string });
    tool(
      name: string,
      description: string,
      handler: (args: Record<string, unknown>) => unknown,
    ): void;
    tool(
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => unknown,
    ): void;
    connect(transport: unknown): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/streamableHttp' {
  export class StreamableHTTPServerTransport {
    constructor(options: { sessionIdGenerator: undefined | (() => string) });
    handleRequest(req: unknown, res: unknown, body?: unknown): Promise<void>;
    close(): Promise<void>;
  }
}

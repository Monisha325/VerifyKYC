/**
 * Minimal type declarations for the `fuzzball` fuzzy-string-matching library.
 * Only the functions used in identity correlation are declared here.
 */
declare module 'fuzzball' {
  interface Options {
    scorer?: (...args: unknown[]) => number;
    processor?: (s: string) => string;
    full_process?: boolean;
    force_ascii?: boolean;
    useCollator?: boolean;
  }

  /** Token-sort then Levenshtein ratio — good for name fields. Returns 0..100. */
  export function token_sort_ratio(s1: string, s2: string, options?: Options): number;

  /** Token-set ratio — handles extra tokens gracefully. Returns 0..100. */
  export function token_set_ratio(s1: string, s2: string, options?: Options): number;

  /** Simple ratio (no tokenisation). Returns 0..100. */
  export function ratio(s1: string, s2: string, options?: Options): number;

  /** Pre-process a string (lowercase, trim, collapse whitespace). */
  export function full_process(s: string, forceAscii?: boolean): string;
}

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

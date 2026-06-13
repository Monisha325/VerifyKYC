/**
 * Node.js v22 applies the package exports map a second time when loading the
 * absolute path returned by the first resolution. For @modelcontextprotocol/sdk
 * (which has "type":"module" and a ./* wildcard export), this second check fails
 * because the resolved internal dist/cjs path is not itself a named export key.
 *
 * Fix: intercept Module._resolveFilename for the two MCP SDK subpath specifiers
 * and return the absolute path to the .js file directly, bypassing the second
 * exports-map check entirely.
 *
 * __dirname is core/src/ under ts-node and core/dist/ when compiled — both
 * resolve ../node_modules to core/node_modules, where the SDK lives.
 *
 * This file MUST be the first import in index.ts so the hook is registered
 * before any agent file triggers an MCP SDK require().
 */

import * as path from 'path';

const Module = require('module') as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
};

const SDK_CJS = path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs');

const OVERRIDES: Record<string, string> = {
  '@modelcontextprotocol/sdk/server/mcp':            path.join(SDK_CJS, 'server', 'mcp.js'),
  '@modelcontextprotocol/sdk/server/streamableHttp': path.join(SDK_CJS, 'server', 'streamableHttp.js'),
};

const _orig = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (Object.prototype.hasOwnProperty.call(OVERRIDES, request)) {
    return OVERRIDES[request];
  }
  return _orig.call(this, request, parent, isMain, options);
};

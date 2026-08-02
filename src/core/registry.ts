/**
 * Registries: init-frozen process state (backbone + state)
 * Tools and middlewares registered at boot.
 * Validation at startup (dupe keys panic), per-request warning.
 */
import { ToolDef, MiddlewareEntry, ToolRegistry, MiddlewareRegistry, AgentConfig } from './types.js';
import { getLogger } from '../obs/log.js';

const log = getLogger('registry');

let toolsFrozen = false;
const toolRegistry: ToolRegistry = new Map();
let mwRegistry: MiddlewareRegistry = [];

export function registerTool(def: ToolDef) {
  if (toolsFrozen) throw new Error('Tool registry is frozen (init only)');
  if (toolRegistry.has(def.name)) {
    throw new Error(`Duplicate tool registration: ${def.name}`);
  }
  toolRegistry.set(def.name, def);
}

export function freezeToolRegistry() {
  toolsFrozen = true;
}

export function getTool(name: string): ToolDef | undefined {
  return toolRegistry.get(name);
}

export function getAllTools(names?: string[]): ToolDef[] {
  if (!names || names.length === 0) return Array.from(toolRegistry.values());
  return names.map(n => toolRegistry.get(n)).filter(Boolean) as ToolDef[];
}

export function registerMiddleware(entry: MiddlewareEntry) {
  // allow dup check? at startup validate
  mwRegistry.push(entry);
}

export function getMiddlewareRegistry(): MiddlewareRegistry {
  return [...mwRegistry]; // copy
}

export function validateRegistries() {
  // startup validation
  const mwNames = new Set<string>();
  for (const e of mwRegistry) {
    if (mwNames.has(e.name)) {
      throw new Error(`Duplicate middleware in registry: ${e.name}`);
    }
    mwNames.add(e.name);
  }
  // tools already checked on register
}

export function resolveAgentToolsAndMws(agentCfg: AgentConfig) {
  const tools = getAllTools(agentCfg.tools);

  // Per-request validation: log unknown / redundant middleware names from
  // the agent yaml. tool_middleware_chain.md §8: misconfiguration is noisy,
  // not fatal — corruption is fatal (handled in validateRegistries).
  const registeredNames = new Set(mwRegistry.map(e => e.name));
  const seenInCfg = new Set<string>();
  for (const name of agentCfg.middlewares) {
    if (!registeredNames.has(name)) {
      log.warn({ agent: agentCfg.name, middleware: name }, 'unknown middleware in agent config');
    }
    if (seenInCfg.has(name)) {
      log.warn({ agent: agentCfg.name, middleware: name }, 'duplicate middleware in agent config');
    }
    seenInCfg.add(name);
  }
  // Also warn if the agent opts in to a global middleware (redundant).
  for (const e of mwRegistry) {
    if (e.activation === 'global' && agentCfg.middlewares.includes(e.name)) {
      log.warn({ agent: agentCfg.name, middleware: e.name }, 'redundant opt-in to global middleware');
    }
  }

  // Tool name validation too: unknown tool names in agent yaml.
  for (const tname of agentCfg.tools) {
    if (!toolRegistry.has(tname)) {
      log.warn({ agent: agentCfg.name, tool: tname }, 'unknown tool in agent config');
    }
  }

  const mws = mwRegistry.filter(e =>
    e.activation === 'global' || agentCfg.middlewares.includes(e.name)
  );
  return { tools, middlewareEntries: mws };
}

/** Call at boot after all registers. Idempotent: re-calls are no-ops. */
export function initRegistries() {
  validateRegistries();
  if (!toolsFrozen) {
    freezeToolRegistry();
    log.info({ tools: toolRegistry.size, middlewares: mwRegistry.length }, 'registries frozen');
  }
}

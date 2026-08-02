/**
 * Tool Middleware Chain (tool_middleware_chain.md)
 * Onion composition (wrap next).
 * Global vs per-agent activation.
 * Soft activation: factory can return null.
 * Three shapes in one interface (filter/rewrite/observe by behavior).
 * Late binding via thunks in BuildContext.
 * Errors propagate; intentional clean short-circuit returns [] (no calls) distinct from error.
 * Cross-module via shared callbacks bag.
 * Registry order-of-truth at init.
 */
import {
  Middleware, ToolInvoker, ToolCallRequest, ToolCallResult,
  BuildContext, AgentConfig, MiddlewareEntry, CLEAN_TERMINATION,
} from './types.js';

export class MiddlewareChain {
  private installed: Middleware[] = [];

  constructor(private buildCtx: BuildContext) {}

  /** Install from registry entries that activate for this agent. Order from registry. */
  installFromRegistry(registry: MiddlewareEntry[], agentCfg: AgentConfig) {
    this.installed = [];

    for (const entry of registry) {
      const isPerAgent = entry.activation === 'per-agent';
      const optedIn = agentCfg.middlewares.includes(entry.name);

      if (isPerAgent && !optedIn) continue;
      // global: always try, even if not listed

      const mw = entry.factory(this.buildCtx, agentCfg);
      if (mw) {
        this.installed.push(mw);
      }
      // soft: null means don't install for this request
    }
  }

  /** Compose the onion: outermost first in array applies last in call stack? Wait standard wrap. */
  getInvoker(finalInvoker: ToolInvoker): ToolInvoker {
    // Build from inside out
    let current = finalInvoker;

    // Reverse: last registered is innermost? Registry order: earlier wraps later.
    // Per docs: ordering matters, fixed at init. First in registry is outermost?
    // To match "wrap the next", we apply in reverse registration for correct stack.
    for (let i = this.installed.length - 1; i >= 0; i--) {
      const mw = this.installed[i];
      current = mw(current);
    }
    return current;
  }

  /** Helper to check if a result list means clean stop */
  static isCleanTermination(res: ToolCallResult[] | symbol | null): boolean {
    return res === CLEAN_TERMINATION || (Array.isArray(res) && res.length === 0);
  }
}

/**
 * Example middleware factories (users register these)
 */
export function createFilterExample(name: string): MiddlewareEntry {
  return {
    name,
    activation: 'per-agent',
    factory: (ctx, cfg) => {
      return (next) => async (calls) => {
        // e.g. veto certain calls
        const filtered = calls.filter(c => c.name !== 'dangerous');
        if (filtered.length === 0 && calls.length > 0) {
          // clean short circuit: model never knows
          return CLEAN_TERMINATION as any;
        }
        return next(filtered);
      };
    },
  };
}

export function createRewriteExample(): MiddlewareEntry {
  return {
    name: 'rewrite-demo',
    activation: 'global',
    factory: () => (next) => async (calls) => {
      const rewritten = calls.map(c => ({
        ...c,
        arguments: { ...c.arguments, _rewritten: true },
      }));
      const results = await next(rewritten);
      // post process results too
      return results.map(r => ({ ...r, content: r.content + ' [post-rewritten]' }));
    },
  };
}

export function createObserverExample(cbName = 'onToolResult'): MiddlewareEntry {
  return {
    name: 'observer-demo',
    activation: 'global',
    factory: (buildCtx) => (next) => async (calls) => {
      const results = await next(calls);
      const cb = buildCtx.callbacks[cbName];
      if (cb) cb({ calls, results });
      return results;
    },
  };
}

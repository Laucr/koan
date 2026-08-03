/**
 * Core types for Koan's ReAct agent framework.
 * Designed to faithfully implement the philosophies in philosophy/*.md
 */

import { z } from 'zod';

// --- Lifetimes (state_and_lifecycle.md) ---
export type Lifetime =
  | 'per-request-in-memory'   // GC at request end, single "goroutine" (sequential async)
  | 'per-request-persistence' // survives via callbacks to persistence layer
  | 'process-level';          // init-frozen, read-only after boot

export type SignalLifetime =
  | 'one-shot'     // cleared at round end
  | 'session-wide' // persists every round, never auto-cleared
  | 'monotonic'    // set once, survives round ends
  | 'derived';     // recomputed every round from state

// --- Termination (loop_termination.md) ---
export const TerminationReason = {
  NO_TOOL_CALLS: 'no_tool_calls',
  MIDDLEWARE_VETO: 'middleware_veto',
  TERMINATOR_TOOL: 'terminator_tool',
  ROUND_BUDGET: 'round_budget',
} as const;
export type TerminationReason = typeof TerminationReason[keyof typeof TerminationReason];

// --- Tool Decision Gate (tool_vs_llm_decision.md) ---
export const ToolGateMode = {
  AUTO: 'auto',     // model decides
  FORCE: 'force',   // must call (specific class, e.g. search)
  FORBID: 'forbid', // must not call
} as const;
export type ToolGateMode = typeof ToolGateMode[keyof typeof ToolGateMode];

export type ToolClass = 'search' | 'other';

// --- Memory Strategies (memory_mechanism.md) ---
export const CompactionStrategy = {
  NONE: 'none',
  REMOVE: 'remove',
  EMPTY: 'empty',
  PREFIX: 'prefix',
  PREFIX_WITH_REF: 'prefix_with_ref',
} as const;
export type CompactionStrategy = typeof CompactionStrategy[keyof typeof CompactionStrategy];

// --- Middleware shapes (tool_middleware_chain.md) ---
export type ToolCallRequest = {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolCallResult = {
  id?: string;
  name: string;
  content: string;
  error?: boolean;
  // for recovery refs etc.
  meta?: Record<string, unknown>;
};

export type ToolInvoker = (calls: ToolCallRequest[]) => Promise<ToolCallResult[]>;

export type Middleware = (next: ToolInvoker) => ToolInvoker;

// Filter can return [] to short-circuit cleanly (no error)
export const CLEAN_TERMINATION = Symbol('clean_termination');

// --- History / Messages (history_processing.md) ---
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface MediaRef {
  kind: 'image' | 'video' | 'document';
  id: number; // monotonically increasing, stable across turns
  // payload ref or data
}

export interface RawMessage {
  role: Role;
  content: string | Array<{ type: string; [k: string]: unknown }>;
  toolCalls?: ToolCallRequest[];
  toolCallId?: string; // for tool role
  media?: MediaRef[];
  // original turn info
}

export interface ProcessedMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
  tokens: number; // cached at conversion
  media?: MediaRef[];
  // attribution for folding
  originalIndex?: number;
  isInSuffix: boolean; // after the slice point (last user msg)
}

// History split: settled prefix + in-flight suffix
export interface ConversationHistory {
  prefix: ProcessedMessage[]; // before most recent user message (settled)
  suffix: ProcessedMessage[]; // from most recent user onward (being built by react)
  // persistent counters
  nextMediaId: { image: number; video: number; document: number };
}

// --- Tool Permission (M3) ---
// Coarse-grained capability needed by a tool. The runtime refuses to call a
// tool whose permission isn't granted in the current run (either statically
// via --auto-approve or interactively via the approval callback).
export type ToolPermission = 'read' | 'write' | 'shell' | 'network';

// --- Tool Definition (for registration and terminator) ---
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema like
  // per philosophy: terminator is per-agent declaration on the tool
  isTerminator?: boolean;
  // category for gating
  toolClass?: ToolClass;
  // memory_mechanism.md §6: marks the tool as a user-memory write so the
  // runtime intercepts at the wire layer and forces the owner. Name-agnostic.
  isMemoryWrite?: boolean;
  // M3: capability this tool needs. Undefined = no permission gate; used for
  // framework-internal tools like submit_final_answer or recall_folded_memory.
  permission?: ToolPermission;
  // M3: optional Zod schema (or anything with a `.parse(unknown)`) used to
  // validate model-supplied arguments BEFORE invoking the handler. Validation
  // failure produces a structured error result the model can self-correct on.
  paramsSchema?: { parse: (input: unknown) => unknown };
  // handler: actual impl, called after middleware chain
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolCallResult>;
}

export interface ToolContext {
  // late bound things
  sessionId: string;
  userId: string;
  // M3: cancellation propagated from the run.
  signal?: AbortSignal;
  // M3: working-dir / path-allowlist for fs.* tools.
  cwd?: string;
  allowedPaths?: string[];
  // access to memory stores etc via callbacks or injected
}

// --- History protocol modes (history_processing.md §4) ---
//
// Two protocol modes share one pipeline. The choice is a single boolean
// fork at the top of every conversion branch:
//
//   - 'structured': the LLM API speaks typed tool_calls / tool messages
//     (OpenAI-style). The structured path runs an extra invariant-
//     enforcement pass because the API rejects malformed sequences.
//   - 'text': the LLM API has no native tool-call shape. Tool calls and
//     results are encoded inline as <tool_call>/<tool_result> tags in
//     the message content, parsed back out by the runtime.
export const ProtocolMode = {
  STRUCTURED: 'structured',
  TEXT: 'text',
} as const;
export type ProtocolMode = typeof ProtocolMode[keyof typeof ProtocolMode];

// --- Agent Config (plug-in, from yaml or object) ---
export const AgentConfigSchema = z.object({
  name: z.string(),
  systemPromptTemplate: z.string().optional(), // template with {{vars}}
  model: z.string().default('gpt-4o-mini'),
  maxRounds: z.number().int().positive().default(12),
  tokenBudget: z.number().int().positive().default(120_000),
  slackTokens: z.number().int().positive().default(800),
  /** Protocol mode for history assembly + LLM I/O. Default: structured. */
  protocolMode: z.nativeEnum(ProtocolMode).default(ProtocolMode.STRUCTURED),
  // memory
  memory: z.object({
    inConversation: z.object({
      foldStrategy: z.nativeEnum(CompactionStrategy).default(CompactionStrategy.NONE),
      compactWatermark: z.number().int().positive().default(60_000),
    }).default({ foldStrategy: CompactionStrategy.NONE, compactWatermark: 60000 }),
    acrossConversation: z.object({
      enabled: z.boolean().default(false),
    }).default({ enabled: false }),
  }).default({
    inConversation: { foldStrategy: CompactionStrategy.NONE, compactWatermark: 60000 },
    acrossConversation: { enabled: false },
  }),
  // tools available to this agent
  tools: z.array(z.string()).default([]), // names registered in global registry
  // middlewares (per-agent opt-in)
  middlewares: z.array(z.string()).default([]),
  // gate defaults, etc.
  defaultGate: z.object({
    search: z.nativeEnum(ToolGateMode).default(ToolGateMode.AUTO),
  }).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// --- Control Signals (state) ---
export interface ControlSignals {
  // Tool gate pre-decisions (merged at request time)
  searchGate: { mode: ToolGateMode; oneShot: boolean };

  // one-shot force specific tool this round
  forceToolThisRound?: string;

  // retry hints for next LLM call
  retryHint?: string;

  // early no-more-tools hint (before budget)
  noMoreToolsHint?: boolean;
}

// --- Full Session State ---
export interface AgentSessionState {
  // lifetimes encoded
  conversationId: string;
  userId: string;
  agentName: string;

  round: number;
  history: ConversationHistory;

  // orthogonal sub-states
  toolContext: {
    cursors: Record<string, number>;
    artifacts: Record<string, unknown>;
  };

  signals: ControlSignals;

  // signal lifetimes — populated when setSignal is called.
  // round-end hook iterates this map; new signals declare lifetime once and
  // the framework cleans them up correctly. (state_and_lifecycle.md §6)
  signalLifetimes: Partial<Record<keyof ControlSignals, SignalLifetime>>;

  // termination
  terminated?: {
    reason: TerminationReason;
    atRound: number;
  };

  // for persistence callbacks (sparse)
  lastStatus?: string;
  progress?: number;
}

// Callbacks for decoupling persistence (status callbacks)
export type StatusCallback = (update: { status: string; round?: number; [k: string]: unknown }) => void | Promise<void>;

// --- LLM Abstraction ---
export interface LLMRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: any[];
    tool_call_id?: string;
  }>;
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: any };
  }>;
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  // Cancellation. The adapter should pass this through to the underlying SDK
  // so a Ctrl-C kills the in-flight HTTP call, not just the process around it.
  signal?: AbortSignal;
  // Per-call timeout in ms. Adapter is responsible for enforcement; defaults
  // to 60_000 if omitted. The runReActAgent harness fills this in from config.
  timeoutMs?: number;
}

export interface LLMResponse {
  message: {
    content: string | null;
    tool_calls?: Array<{
      id?: string;
      function: { name: string; arguments: string };
    }>;
  };
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export type LLMClient = (req: LLMRequest) => Promise<LLMResponse>;

// --- Build context for late binding (thunks) ---
export interface BuildContext {
  // thunks resolve at runtime
  getSession: () => AgentSessionState;
  getStatusCallback: () => StatusCallback | undefined;
  getUserMemoryFetcher?: () => Promise<Record<string, string>>;
  // shared callback bag for cross-module
  callbacks: Record<string, (...args: any[]) => void | Promise<void>>;
}

// Middleware registry entry
export interface MiddlewareEntry {
  name: string;
  activation: 'global' | 'per-agent';
  // returns the middleware or null if soft-activation decides not to install
  factory: (ctx: BuildContext, agentCfg: AgentConfig) => Middleware | null;
}

// Tool registry is global init-frozen map of name -> ToolDef
export type ToolRegistry = Map<string, ToolDef>;
export type MiddlewareRegistry = MiddlewareEntry[];

// --- Result of a full agent run ---
export interface AgentRunResult {
  finalAnswer: string;
  history: ConversationHistory;
  rounds: number;
  termination: TerminationReason;
  toolCallsMade: number;
  warnings: string[];
  usage?: { promptTokens: number; completionTokens: number };
}

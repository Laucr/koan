// Public API of Koan's ReAct framework.

export * from './core/types.js';
export { ConversationState } from './core/state.js';
export { HistoryProcessor } from './core/history.js';
export { ToolGate } from './core/toolgate.js';
export { MiddlewareChain, createFilterExample, createRewriteExample, createObserverExample } from './core/middleware.js';
export { InConversationMemory, AcrossConversationMemory, PendingWriteQueue } from './core/memory.js';
export type { PendingWrite } from './core/memory.js';
export { runReActAgent } from './core/loop.js';
export {
  registerTool, registerMiddleware, initRegistries, getAllTools,
} from './core/registry.js';
export { createOpenAIClient } from './adapters/openai.js';
export { createAnthropicClient } from './adapters/anthropic.js';
export { createOpenAIStreamingClient } from './adapters/openai-streaming.js';
export { createAnthropicStreamingClient } from './adapters/anthropic-streaming.js';
export type { LLMStreamEvent, LLMStreamingClient } from './core/streaming.js';
export { StreamAccumulator } from './core/streaming.js';
export { countTokens } from './utils/tokens.js';
export { deepCopy } from './utils/defensive.js';
export { loadAgentConfig, createAgentConfig } from './config/agent-loader.js';
export { registerSampleTools } from './core/sample-tools.js';
export {
  registerDefaultToolkit, DEFAULT_TOOLKIT,
  fsReadTool, fsListTool, fsWriteTool, shellExecTool, webFetchTool,
  writeUserMemoryTool,
  submitFinalAnswerTool,
} from './tools/index.js';
export {
  MemorySessionStore, SqliteSessionStore, defaultSessionsDbPath,
  newSessionId, deriveTitle,
  InMemoryUserMemoryStore, SqliteUserMemoryStore,
  memoryFetcherFor,
} from './persistence/index.js';
export type {
  SessionRecord, SessionSummary, SessionMetaPatch, UsageDelta, SessionStore,
  MemoryEntry, UserMemoryStore,
} from './persistence/index.js';
export { startServer } from './server/index.js';
export type { ServeOptions, ServerHandle } from './server/index.js';
export { getLogger, resetLogger } from './obs/log.js';
export { MetricsRegistry, getMetrics, resetMetrics } from './obs/metrics.js';
export { costFor, formatCost } from './obs/cost.js';

// Re-export some constants
export { TerminationReason, CompactionStrategy, ToolGateMode, CLEAN_TERMINATION, ProtocolMode } from './core/types.js';
export { checkTermination } from './core/termination.js';

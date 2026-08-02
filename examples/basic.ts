/**
 * Basic runnable example of the ReAct scaffold.
 * Run with: npm run example   (or npx tsx examples/basic.ts)
 *
 * This demonstrates:
 * - Plug-in tools + terminator
 * - Middleware (observer + filter example)
 * - Gate (forbid search in this case)
 * - Structural termination
 * - In-conv memory with prefix ref + recovery
 * - Across memory (mock)
 * - History truncation, etc.
 */
import {
  runReActAgent,
  createOpenAIClient,
  registerTool,
  registerMiddleware,
  initRegistries,
  createAgentConfig,
  createFilterExample,
  createObserverExample,
  registerSampleTools,
  ToolGateMode,
  CompactionStrategy,
} from '../src/index.js';

async function main() {
  // 1. Register tools and mws at "boot" (init-frozen)
  registerSampleTools();

  // Register some middlewares
  registerMiddleware(createObserverExample('onToolResult'));
  registerMiddleware(createFilterExample('safety-filter'));

  initRegistries();

  // 2. Define agent via config (can come from yaml too)
  const { loadAgentConfig } = await import('../src/index.js');
  const agentCfg = await loadAgentConfig('./examples/demo-agent.yaml');

  // 3. LLM client - use mock for reliable demo without API key
  const { createMockLLM } = await import('./mock-llm.js');
  const llm = createMockLLM('use-tool-then-terminate');

  // 4. Mock user memory fetcher (across-conversation pipeline)
  const mockUserMemory = async (uid: string) => ({
    name: 'Alex',
    preferences: { style: 'bullet points', lang: 'en' },
    last_topic: 'capital cities',
  });

  console.log('=== Starting ReAct Agent Run ===');

  const result = await runReActAgent({
    agentConfig: agentCfg,
    llm,
    userId: 'user_alex_42',
    initialMessages: [
      { role: 'user', content: 'What is the capital of France? Use search to confirm, then give final answer.' },
    ],
    userMemoryFetcher: mockUserMemory,
    // initialGate omitted -> uses agent config (auto)
    statusCallback: (u) => console.log('  [status]', u.status || u),
  });

  console.log('\n=== RESULT ===');
  console.log('Termination:', result.termination);
  console.log('Rounds:', result.rounds);
  console.log('Tool calls:', result.toolCallsMade);
  console.log('Warnings:', result.warnings);
  console.log('\nFinal Answer:\n', result.finalAnswer);
  console.log('\n(History length prefix+suffix):', result.history.prefix.length + result.history.suffix.length);

  // Second run: demonstrate FORBID gate + direct termination (structural no-tool-calls)
  console.log('\n=== SECOND RUN (FORBID search gate, expect direct answer) ===');
  const forbidCfg = await loadAgentConfig('./examples/demo-agent.yaml');
  const mockDirect = (await import('./mock-llm.js')).createMockLLM('direct');
  const result2 = await runReActAgent({
    agentConfig: forbidCfg,
    llm: mockDirect,
    userId: 'user_alex_42',
    initialMessages: [{ role: 'user', content: 'Capital of France?' }],
    userMemoryFetcher: mockUserMemory,
    initialGate: { search: 'forbid' as any },
  });
  console.log('Termination (should be no_tool_calls):', result2.termination);
  console.log('Tool calls made:', result2.toolCallsMade);
  console.log('Final:', result2.finalAnswer.trim());
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

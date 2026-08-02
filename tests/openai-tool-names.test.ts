import { describe, expect, it } from 'vitest';
import { mapOpenAIToolNames } from '../src/adapters/openai-tool-names.js';
import type { LLMRequest } from '../src/core/types.js';

function request(): LLMRequest {
  return {
    model: 'gpt-mock',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fs.read', arguments: '{}' } }],
    }],
    tools: [
      { type: 'function', function: { name: 'fs.read', description: 'read', parameters: {} } },
      { type: 'function', function: { name: 'submit_final_answer', description: 'finish', parameters: {} } },
    ],
    tool_choice: { type: 'function', function: { name: 'fs.read' } },
  };
}

describe('OpenAI tool-name mapping', () => {
  it('maps dotted definitions, history, and tool_choice to valid wire names', () => {
    const mapped = mapOpenAIToolNames(request());

    expect(mapped.tools?.map(tool => tool.function.name)).toEqual([
      'fs_read',
      'submit_final_answer',
    ]);
    expect(mapped.messages[0].tool_calls?.[0].function.name).toBe('fs_read');
    expect((mapped.toolChoice as any).function.name).toBe('fs_read');
  });

  it("maps a model-returned wire name back to Koan's registry name", () => {
    const mapped = mapOpenAIToolNames(request());
    expect(mapped.fromWireName('fs_read')).toBe('fs.read');
    expect(mapped.fromWireName('submit_final_answer')).toBe('submit_final_answer');
  });
});

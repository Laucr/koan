import type { LLMRequest } from '../core/types.js';

const OPENAI_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Translate Koan's namespaced tool names (for example `fs.read`) to names
 * accepted by OpenAI-compatible APIs, then translate model calls back.
 */
export function mapOpenAIToolNames(req: LLMRequest): {
  messages: LLMRequest['messages'];
  tools: LLMRequest['tools'];
  toolChoice: LLMRequest['tool_choice'];
  fromWireName: (name: string) => string;
} {
  const internalToWire = new Map<string, string>();
  const wireToInternal = new Map<string, string>();

  for (const tool of req.tools ?? []) {
    const internal = tool.function.name;
    let wire = toValidName(internal);
    const conflict = wireToInternal.get(wire);
    if (conflict && conflict !== internal) {
      wire = `${wire.slice(0, 54)}_${shortHash(internal)}`;
    }
    internalToWire.set(internal, wire);
    wireToInternal.set(wire, internal);
  }

  const toWireName = (name: string): string => internalToWire.get(name) ?? toValidName(name);
  const fromWireName = (name: string): string => wireToInternal.get(name) ?? name;

  const messages = req.messages.map(message => ({
    ...message,
    tool_calls: message.tool_calls?.map((call: any) => ({
      ...call,
      function: {
        ...call.function,
        name: toWireName(call.function?.name ?? ''),
      },
    })),
  }));

  const tools = req.tools?.map(tool => ({
    ...tool,
    function: { ...tool.function, name: toWireName(tool.function.name) },
  }));

  const toolChoice = typeof req.tool_choice === 'object'
    ? {
        ...req.tool_choice,
        function: {
          ...req.tool_choice.function,
          name: toWireName(req.tool_choice.function.name),
        },
      }
    : req.tool_choice;

  return { messages, tools, toolChoice, fromWireName };
}

function toValidName(name: string): string {
  if (OPENAI_TOOL_NAME.test(name) && name.length <= 64) return name;
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
  if (sanitized.length <= 64) return sanitized;
  return `${sanitized.slice(0, 54)}_${shortHash(name)}`;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Agent config loader. Supports yaml or plain object. (plug-in surface)
 */
import * as yaml from 'js-yaml';
import { AgentConfig, AgentConfigSchema } from '../core/types.js';
import fs from 'node:fs/promises';

export async function loadAgentConfig(pathOrObj: string | object): Promise<AgentConfig> {
  let raw: any;
  if (typeof pathOrObj === 'string') {
    const content = await fs.readFile(pathOrObj, 'utf8');
    if (pathOrObj.endsWith('.yaml') || pathOrObj.endsWith('.yml')) {
      raw = yaml.load(content);
    } else {
      raw = JSON.parse(content);
    }
  } else {
    raw = pathOrObj;
  }
  return AgentConfigSchema.parse(raw);
}

export function createAgentConfig(overrides: Partial<AgentConfig> & { name: string }): AgentConfig {
  return AgentConfigSchema.parse(overrides);
}

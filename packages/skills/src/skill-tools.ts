/** Python-parity `skill` tool: catalog metadata now, full body on invocation. */

import type {
  LLMMessage,
  ToolBatchCall,
  ToolBatchResult,
  ToolContext,
  ToolDefinition,
  ToolDefinitionSummary,
  ToolExecutor,
  ToolResult,
} from '@dongkseo/contracts';
import { SkillRegistry } from './skill-registry.js';

export class SkillTools implements ToolExecutor {
  readonly withTools?: (tools: ToolDefinition[]) => ToolExecutor;
  readonly withContext?: (context: ToolContext) => ToolExecutor;
  readonly getContext?: () => ToolContext;

  constructor(
    private readonly inner: ToolExecutor,
    private readonly registry: SkillRegistry,
  ) {
    if (inner.list().some(definition => definition.name === 'skill')) {
      throw new Error("the wrapped tool collection already defines 'skill'");
    }
    if (inner.withTools) {
      this.withTools = tools => {
        const exposesSkill = tools.some(tool => tool.name === 'skill');
        const rebound = inner.withTools!(tools.filter(tool => tool.name !== 'skill'));
        return exposesSkill ? new SkillTools(rebound, registry) : rebound;
      };
    }
    if (inner.withContext) {
      this.withContext = context => new SkillTools(inner.withContext!(context), registry);
    }
    if (inner.getContext) this.getContext = inner.getContext.bind(inner);
  }

  async prepare(messages: LLMMessage[]): Promise<void> {
    await this.registry.list();
    await this.inner.prepare?.(messages);
  }

  list(): ToolDefinitionSummary[] {
    return [...this.inner.list(), summary(this.definition())];
  }

  get(name: string): ToolDefinition | undefined {
    return name === 'skill' ? this.definition() : this.inner.get?.(name);
  }

  async execute(
    name: string,
    callId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (name !== 'skill') return this.inner.execute(name, callId, input, signal);
    return this.load(input);
  }

  async executeBatch(calls: ToolBatchCall[], signal?: AbortSignal): Promise<ToolBatchResult[]> {
    const skillCall = calls.find(call => call.name === 'skill');
    if (skillCall) {
      const result = await this.load(skillCall.input);
      return [{ callId: skillCall.callId, name: skillCall.name, result, isError: result.type === 'error' }];
    }
    if (this.inner.executeBatch) return this.inner.executeBatch(calls, signal);
    const results: ToolBatchResult[] = [];
    for (const call of calls) {
      const result = await this.inner.execute(call.name, call.callId, call.input, signal) as ToolResult;
      results.push({
        callId: call.callId,
        name: call.name,
        result,
        isError: result.type === 'error',
      });
    }
    return results;
  }

  private async load(input: unknown): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.skill !== 'string') {
      return { type: 'error', message: "skill requires a string 'skill' argument" };
    }
    const name = input.skill.replace(/^\//, '').trim();
    const skill = await this.registry.load(name);
    if (!skill) return { type: 'error', message: `unknown skill: ${name}` };
    const args = input.args ?? '';
    if (typeof args !== 'string') {
      return { type: 'error', message: "skill 'args' must be a string" };
    }
    return {
      type: 'text',
      text: `Loaded skill ${skill.name}.`,
      contextMessages: [{
        content: skill.context(args),
        metadata: {
          kind: 'skill',
          name: skill.name,
          allowedTools: [...skill.allowedTools],
          ...(skill.origin ? { origin: skill.origin } : {}),
        },
      }],
    };
  }

  private definition(): ToolDefinition {
    return {
      name: 'skill',
      description:
        'Load a matching skill before doing the task. The tool injects the full ' +
        'instructions into the next model round; do not guess unlisted names.\n\n' +
        this.registry.catalogSnapshot(),
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Exact skill name' },
          args: { type: 'string', description: 'Optional skill arguments' },
        },
        required: ['skill'],
        additionalProperties: false,
      },
      isExclusive: true,
      isReadOnly: true,
      isConcurrencySafe: false,
      execute: async (_callId, input) => this.load(input),
    };
  }
}

function summary(definition: ToolDefinition): ToolDefinitionSummary {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

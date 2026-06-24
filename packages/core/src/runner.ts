/**
 * AgentRunner — public AgentRuntime facade.
 *
 * The actual in-process execution driver lives in LocalExecutionHarness so other
 * runtime strategies can plug into the same boundary later.
 */

import type {
  AgentEvent,
  AgentInput,
  AgentRuntime,
  ExecutionHarness,
} from '@dongkseo/contracts';
import {
  LocalExecutionHarness,
  type LocalExecutionHarnessOptions,
} from './execution-harness.js';

export type AgentRunnerOptions = LocalExecutionHarnessOptions;

export class AgentRunner implements AgentRuntime {
  private readonly harness: ExecutionHarness;

  constructor(options: AgentRunnerOptions) {
    this.harness = new LocalExecutionHarness(options);
  }

  execute(input: AgentInput): AsyncGenerator<AgentEvent> {
    return this.harness.execute(input);
  }

  abort(): void {
    this.harness.abort();
  }

  steer(text: string): boolean {
    return this.harness.steer?.(text) ?? false;
  }
}

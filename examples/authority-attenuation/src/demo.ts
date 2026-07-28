/**
 * Delegation authority attenuation — a self-contained, deterministic end-to-end
 * demo (no LLM). It exercises the REAL machinery:
 *
 *   parent  →  createDelegateTool({ currentAuthority, authorityForChild })
 *             stamps attenuate(...) as `inheritedAuthority` on the outbound hop
 *          →  LocalTransport delivers the envelope
 *          →  child reads `envelope.metadata.inheritedAuthority` and builds its
 *             approval gate via createEscalationGuard(inherited)  ← consumer wiring
 *          →  a tool outside the inherited grant is DENIED; one inside runs.
 *
 * Parent holds {docs.read, docs.write} but grants the child only {docs.read},
 * so the child can never escalate to docs.write — enforced at the gate.
 */

import {
  createDelegateTool,
  createApprovalGateMiddleware,
  createEscalationGuard,
  InMemoryApprovalPolicyStore,
} from '@dongkseo/tools';
import { LocalTransport } from '@dongkseo/transport';
import { InMemoryAgentRegistry } from '@dongkseo/registry';
import { textResult, topic } from '@dongkseo/contracts';
import type { ToolDefinition, ToolContext, AgentCard } from '@dongkseo/contracts';

export interface DemoOutcome {
  tool: string;
  group: string;
  allowed: boolean;
  detail: string;
}

export interface DemoResult {
  /** The authority the child actually received over the transport hop. */
  inheritedByChild: readonly string[] | undefined;
  outcomes: DemoOutcome[];
}

const ctx: ToolContext = {
  tenantId: 'default',
  workdir: '/tmp',
  secrets: { get: async () => undefined },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as ToolContext;

function groupedTool(name: string, group: string): ToolDefinition {
  return {
    name,
    description: `demo tool in policy group ${group}`,
    parameters: { type: 'object', properties: {} },
    policyGroups: [group],
    execute: async () => textResult(`${name} ran`),
  };
}

export async function runAuthorityDemo(): Promise<DemoResult> {
  const transport = new LocalTransport();
  const registry = new InMemoryAgentRegistry();
  const store = new InMemoryApprovalPolicyStore();

  const childCard: AgentCard = {
    name: 'docs-worker',
    version: '0.1.0',
    description: 'Handles docs tasks under delegated authority',
    capabilities: ['docs-work'],
    subscribes: [topic('docs-work.requested')],
    publishes: [],
    tools: [],
    architecture: 'echo',
  };
  await registry.register(childCard);

  const outcomes: DemoOutcome[] = [];
  let inheritedByChild: readonly string[] | undefined;

  // Fire-and-forget delivery runs the child handler on a later tick, so we wait
  // on this promise for the child hop to finish before returning.
  let childDone!: () => void;
  const childHopComplete = new Promise<void>((resolve) => {
    childDone = resolve;
  });

  // ── CHILD runtime: the consumer wiring ──────────────────────────────────
  // On a delegated request, build the approval gate from the authority carried
  // in the envelope. In a real app this one line lives in bootstrapAgent's
  // createRuntime({ envelope }); here it lives in the subscriber to stay
  // self-contained and LLM-free.
  transport.subscribe('docs-work.requested', async (env) => {
    try {
      const inherited = env.metadata.inheritedAuthority;
      inheritedByChild = inherited;

      const gate = createApprovalGateMiddleware({
        transport,
        store,
        resolveGroupAction: createEscalationGuard(inherited),
      });
      const gated = (tool: ToolDefinition): ToolDefinition => {
        const wrapper = { tools: [tool] };
        gate.beforeExecution(wrapper);
        return wrapper.tools[0];
      };

      for (const tool of [groupedTool('docs_read', 'docs.read'), groupedTool('docs_write', 'docs.write')]) {
        const res = await gated(tool).execute('call', {}, ctx);
        outcomes.push({
          tool: tool.name,
          group: tool.policyGroups![0],
          allowed: res.type !== 'error',
          detail: res.type === 'error' ? res.message : res.type === 'text' ? res.text : res.type,
        });
      }
    } finally {
      childDone();
    }
  });

  // ── PARENT: delegate with attenuation ───────────────────────────────────
  // Parent's own authority is {docs.read, docs.write}; it grants the child only
  // {docs.read}. attenuate() guarantees the child can never exceed it.
  const delegate = createDelegateTool({
    transport,
    registry,
    callerAgentName: 'parent',
    currentAuthority: ['docs.read', 'docs.write'],
    authorityForChild: ['docs.read'],
  });

  await delegate.execute(
    'delegate-call',
    { capability: 'docs-work', input: { task: 'summarize the docs' }, waitForResult: false },
    ctx,
  );
  await childHopComplete;

  return { inheritedByChild, outcomes };
}

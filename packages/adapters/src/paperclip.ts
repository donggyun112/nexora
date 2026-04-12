/**
 * PaperclipAdapter — bridges Nexora agents into a Paperclip company.
 *
 * Paperclip is a control plane for AI companies: org charts, goals, budgets,
 * approvals. Nexora is the execution plane: agent runtime, tools, transport.
 * This adapter connects the two.
 *
 * How it works:
 *   1. On start(), registers each Nexora agent as a Paperclip "employee"
 *      via the Paperclip REST API (POST /api/agents)
 *   2. Listens for Paperclip heartbeat pings (periodic "wake up and check
 *      for work" signals) via webhook or polling
 *   3. On heartbeat: fetches assigned issues from Paperclip, converts them
 *      to InboundMessages, routes through the Nexora MessageRouter
 *   4. Posts the agent's response back to Paperclip as an issue comment
 *   5. On stop(), marks the agent as offline
 *
 * SDK-independent: communicates with Paperclip via a minimal PaperclipClient
 * interface (just fetch calls). No Paperclip SDK dependency.
 *
 * Usage:
 *   const adapter = new PaperclipAdapter({
 *     client: { baseUrl: 'http://localhost:3100', apiKey: '...' },
 *     companyId: 'company-uuid',
 *     agents: [helpdeskCard, reviewerCard],
 *   });
 *   await adapter.start(router);
 */

import type {
  Adapter,
  MessageRouter,
  InboundMessage,
  AgentCard,
} from '@nexora/contracts';

// ─── Paperclip API types (minimal) ────────────────────────────────────────

export interface PaperclipClientConfig {
  /** Paperclip server URL (e.g. http://localhost:3100) */
  baseUrl: string;
  /** API key or JWT for authentication */
  apiKey: string;
}

export interface PaperclipIssue {
  id: string;
  title: string;
  body: string;
  status: string;
  assigneeAgentId?: string;
}

export interface PaperclipAdapterOptions {
  /** Paperclip connection config */
  client: PaperclipClientConfig;
  /** Which Paperclip company to register agents in */
  companyId: string;
  /** Nexora agent cards to register as Paperclip employees */
  agents: AgentCard[];
  /** Heartbeat polling interval (ms). Default: 30000 (30s) */
  heartbeatIntervalMs?: number;
  /** Tenant ID to use for Nexora routing. Default: companyId */
  tenantId?: string;
}

export class PaperclipAdapter implements Adapter {
  readonly name = 'paperclip';
  private readonly config: PaperclipClientConfig;
  private readonly companyId: string;
  private readonly agents: AgentCard[];
  private readonly heartbeatIntervalMs: number;
  private readonly tenantId: string;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly registeredAgentIds = new Map<string, string>();
  /** C3 FIX: issues currently being processed — prevents reprocessing on next heartbeat. */
  private readonly inFlightIssues = new Set<string>();
  /** C3 FIX: issues we've already posted a comment on — prevents duplicate comments. */
  private readonly processedIssues = new Set<string>();
  private heartbeatRunning = false;

  constructor(options: PaperclipAdapterOptions) {
    this.config = options.client;
    this.companyId = options.companyId;
    this.agents = options.agents;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.tenantId = options.tenantId ?? options.companyId;
  }

  async start(router: MessageRouter): Promise<void> {
    // Register each Nexora agent as a Paperclip employee
    for (const card of this.agents) {
      try {
        const agentId = await this.registerAgent(card);
        this.registeredAgentIds.set(card.name, agentId);
        console.log(`[Paperclip] Registered ${card.name} → ${agentId}`);
      } catch (err) {
        console.error(`[Paperclip] Failed to register ${card.name}:`, err);
      }
    }

    // Start heartbeat polling
    this.pollingTimer = setInterval(() => {
      void this.heartbeat(router);
    }, this.heartbeatIntervalMs);
    this.pollingTimer.unref?.();

    // Run first heartbeat immediately
    void this.heartbeat(router);
  }

  async stop(): Promise<void> {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    // Mark agents as offline
    for (const [name, agentId] of this.registeredAgentIds) {
      try {
        await this.api('PATCH', `/api/agents/${agentId}`, { status: 'offline' });
      } catch {
        // Best effort
      }
    }
    this.registeredAgentIds.clear();
  }

  // ─── Paperclip API helpers ─────────────────────────────────────────────

  private async registerAgent(card: AgentCard): Promise<string> {
    const body = {
      companyId: this.companyId,
      name: card.name,
      title: card.description,
      capabilities: card.capabilities.join(', '),
      adapterType: 'nexora',
      adapterConfig: {
        subscribes: card.subscribes,
        publishes: card.publishes,
        tools: card.tools,
        architecture: card.architecture,
      },
    };

    const res = await this.api('POST', '/api/agents', body);
    return (res as { id: string }).id;
  }

  private async heartbeat(router: MessageRouter): Promise<void> {
    // C3 FIX: single-flight guard — if previous heartbeat is still running, skip.
    if (this.heartbeatRunning) return;
    this.heartbeatRunning = true;

    try {
      await this.heartbeatInner(router);
    } finally {
      this.heartbeatRunning = false;
    }
  }

  private async heartbeatInner(router: MessageRouter): Promise<void> {
    for (const [agentName, agentId] of this.registeredAgentIds) {
      try {
        const issues = await this.api(
          'GET',
          `/api/issues?assigneeAgentId=${agentId}&status=open`,
        ) as PaperclipIssue[];

        for (const issue of issues) {
          // C3 FIX: skip already-processed or in-flight issues
          if (this.processedIssues.has(issue.id) || this.inFlightIssues.has(issue.id)) {
            continue;
          }
          this.inFlightIssues.add(issue.id);

          const inbound: InboundMessage = {
            platform: 'paperclip',
            channelId: issue.id,
            userId: 'paperclip-system',
            displayName: 'Paperclip',
            content: `${issue.title}\n\n${issue.body}`,
            tenantId: this.tenantId,
            conversationId: issue.id,
          };

          try {
            const response = await router.route(inbound);
            await this.api('POST', `/api/issues/${issue.id}/comments`, {
              agentId,
              body: response.content,
            });
            this.processedIssues.add(issue.id);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Paperclip] ${agentName} failed on issue ${issue.id}:`, msg);
          } finally {
            this.inFlightIssues.delete(issue.id);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Paperclip] Heartbeat failed for ${agentName}:`, msg);
      }
    }
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Paperclip API ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return {};
  }
}

/**
 * ApprovalPolicyStore — remembers prior approvals so the same action is not
 * re-prompted on every call.
 *
 * Two scopes:
 *   - session: keyed by (tenantId, sessionKey, approvalKey). Lives in memory
 *     only — cleared when the process restarts or when the agent session ends.
 *   - tenant:  keyed by (tenantId, approvalKey). Survives restarts when a
 *     persistent backend is provided.
 *
 * Lookup semantics: tenant scope wins over session scope (an always-allowed
 * action is allowed even in sessions that never granted session-scope).
 */
import type { ApprovalChoice } from './approval.js';

export type ApprovalDecision = 'allow' | 'deny' | 'unknown';

export interface ApprovalRecord {
  tenantId: string;
  approvalKey: string;
  choice: Exclude<ApprovalChoice, 'once'>; // 'once' is never cached
  decidedAt: number;
  decidedBy?: string;
}

/**
 * Pluggable persistence for tenant-permanent records. Default implementation
 * keeps everything in memory; callers wanting durability can pass a backend
 * that writes to @nexora/store.
 */
export interface ApprovalPolicyStore {
  /** Look up the cached decision for (tenant, session, key). */
  lookup(
    tenantId: string,
    sessionKey: string,
    approvalKey: string,
  ): Promise<ApprovalDecision>;
  /** Record a 'session' choice (in-memory, never persisted). */
  rememberSession(
    tenantId: string,
    sessionKey: string,
    approvalKey: string,
    choice: 'session',
    decidedBy?: string,
  ): Promise<void>;
  /** Record an 'always' choice (persisted if backend supports it). */
  rememberAlways(
    tenantId: string,
    approvalKey: string,
    decidedBy?: string,
  ): Promise<void>;
  /** Record an explicit deny. Default scope: session. */
  rememberDeny(
    tenantId: string,
    sessionKey: string,
    approvalKey: string,
    decidedBy?: string,
    scope?: 'session' | 'always',
  ): Promise<void>;
  /** Drop all session-scope records for a given sessionKey. */
  clearSession(tenantId: string, sessionKey: string): Promise<void>;
}

interface SessionRecord {
  choice: Exclude<ApprovalChoice, 'once'>;
  decidedAt: number;
  decidedBy?: string;
}

export class InMemoryApprovalPolicyStore implements ApprovalPolicyStore {
  private readonly session = new Map<string, Map<string, SessionRecord>>();
  private readonly always = new Map<string, ApprovalRecord>();

  async lookup(
    tenantId: string,
    sessionKey: string,
    approvalKey: string,
  ): Promise<ApprovalDecision> {
    const tenantAlways = this.always.get(this.alwaysId(tenantId, approvalKey));
    if (tenantAlways) {
      return tenantAlways.choice === 'deny' ? 'deny' : 'allow';
    }
    const sessionMap = this.session.get(this.sessionId(tenantId, sessionKey));
    const record = sessionMap?.get(approvalKey);
    if (!record) return 'unknown';
    return record.choice === 'deny' ? 'deny' : 'allow';
  }

  async rememberSession(
    tenantId: string,
    sessionKey: string,
    approvalKey: string,
    choice: 'session',
    decidedBy?: string,
  ): Promise<void> {
    const sid = this.sessionId(tenantId, sessionKey);
    let map = this.session.get(sid);
    if (!map) {
      map = new Map();
      this.session.set(sid, map);
    }
    map.set(approvalKey, { choice, decidedAt: Date.now(), decidedBy });
  }

  async rememberAlways(
    tenantId: string,
    approvalKey: string,
    decidedBy?: string,
  ): Promise<void> {
    this.always.set(this.alwaysId(tenantId, approvalKey), {
      tenantId,
      approvalKey,
      choice: 'always',
      decidedAt: Date.now(),
      decidedBy,
    });
  }

  async rememberDeny(
    tenantId: string,
    sessionKey: string,
    approvalKey: string,
    decidedBy?: string,
    scope: 'session' | 'always' = 'session',
  ): Promise<void> {
    if (scope === 'always') {
      this.always.set(this.alwaysId(tenantId, approvalKey), {
        tenantId,
        approvalKey,
        choice: 'deny',
        decidedAt: Date.now(),
        decidedBy,
      });
      return;
    }
    const sid = this.sessionId(tenantId, sessionKey);
    let map = this.session.get(sid);
    if (!map) {
      map = new Map();
      this.session.set(sid, map);
    }
    map.set(approvalKey, { choice: 'deny', decidedAt: Date.now(), decidedBy });
  }

  async clearSession(tenantId: string, sessionKey: string): Promise<void> {
    this.session.delete(this.sessionId(tenantId, sessionKey));
  }

  private sessionId(tenantId: string, sessionKey: string): string {
    return `${tenantId}::${sessionKey}`;
  }

  private alwaysId(tenantId: string, approvalKey: string): string {
    return `${tenantId}::${approvalKey}`;
  }
}

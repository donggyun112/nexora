export type RuntimeKind =
  | 'react'
  | 'remote'
  | 'deterministic'
  | 'mcp'
  | 'http'
  | (string & {});

export type AdapterKind =
  | 'native'
  | 'http'
  | 'mcp'
  | 'hermes'
  | 'openclaw'
  | 'claude-code'
  | (string & {});

export type RuntimeAdapterRef = AdapterKind;

export type AdapterEndpoint =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'topic'; topic: string }
  | { type: 'mcp'; server: string; tool?: string }
  | { type: 'local'; name: string }
  | { type: 'custom'; value: Record<string, unknown> };

export type RuntimeSpec =
  | ReactRuntimeSpec
  | RemoteRuntimeSpec
  | DeterministicRuntimeSpec
  | CustomRuntimeSpec;

export interface ReactRuntimeSpec {
  kind: 'react';
  architecture?: string;
  persona?: string;
  config?: Record<string, unknown>;
}

export interface RemoteRuntimeSpec {
  kind: 'remote';
  adapter: AdapterKind;
  target: AdapterEndpoint;
  timeoutMs?: number;
  config?: Record<string, unknown>;
}

export interface DeterministicRuntimeSpec {
  kind: 'deterministic';
  entrypoint: string;
  config?: Record<string, unknown>;
}

export interface CustomRuntimeSpec {
  kind: Exclude<RuntimeKind, 'react' | 'remote' | 'deterministic'>;
  config?: Record<string, unknown>;
}

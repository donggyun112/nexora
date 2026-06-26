import { describe, it, expect } from 'vitest';
import {
  monitoringToolDefinitions,
  registerMonitoringTools,
} from '../builtin/monitoring-bundle.js';
import { ToolRegistry } from '../registry.js';

const SELF_WAKE = ['schedule_monitor', 'cancel_monitor', 'list_monitors'];
const BACKGROUND = ['watch_task', 'check_tasks', 'cancel_task', 'read_task_output', 'watch_output'];

describe('monitoring-bundle', () => {
  it('bundles the self-wake + background-observation tools by default', () => {
    const names = monitoringToolDefinitions().map(t => t.name).sort();
    expect(names).toEqual([...SELF_WAKE, ...BACKGROUND].sort());
  });

  it('omits background-task tools when backgroundTasks:false', () => {
    const names = monitoringToolDefinitions({ backgroundTasks: false }).map(t => t.name).sort();
    expect(names).toEqual([...SELF_WAKE].sort());
  });

  it('every bundled tool is constructed with no required wiring (deps come from ToolContext)', () => {
    // Smoke: each definition is a valid ToolDefinition with an execute fn.
    for (const tool of monitoringToolDefinitions()) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('registerMonitoringTools adds all of them to a ToolRegistry', () => {
    const registry = new ToolRegistry();
    registerMonitoringTools(registry);
    const names = registry.names().sort();
    expect(names).toEqual([...SELF_WAKE, ...BACKGROUND].sort());
  });
});

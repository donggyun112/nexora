/**
 * 9 builtin tools: file I/O + exec + knowledge + web search + handraise + delegate.
 */

export { createExecTool } from './exec.js';
export type { ExecToolOptions } from './exec.js';

export { createReadTool } from './read.js';
export { createGrepTool } from './grep.js';
export { createWriteTool } from './write.js';
export { createEditTool } from './edit.js';

export { createKnowledgeTool } from './knowledge.js';

export { createWebSearchTool } from './web-search.js';
export type { SearchBackend, SearchResult } from './web-search.js';

export { createHandraiseTool } from './handraise.js';
export type {
  HandraiseToolOptions,
  HandraiseRecipient,
  HandraiseRequestPayload,
  HandraiseReplyPayload,
} from './handraise.js';

export { createDelegateTool, DELEGATION_DEPTH_KEY } from './delegate.js';
export type { DelegateToolOptions } from './delegate.js';

/**
 * @nexora/tools/reporter — typed activity events for outbound UIs.
 */

export {
  isReportEnvelopePayload,
  reportTopic,
} from './events.js';
export type {
  ReportEvent,
  ReportEnvelopePayload,
  ReportSeverity,
  ToolStartReport,
  ToolEndReport,
  ThinkingReport,
  CompactReport,
  BudgetReport,
  ErrorReport,
} from './events.js';

export { createReporterMiddleware } from './middleware.js';
export type {
  ReporterContext,
  ReporterMiddlewareOptions,
  ReporterPredicate,
  ReporterPredicateInput,
  ReporterEventKind,
} from './middleware.js';

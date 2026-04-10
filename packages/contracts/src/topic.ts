/**
 * Topic — 에이전트 간 pub/sub 통신의 주소 체계.
 *
 * 에이전트는 이름이 아닌 topic/capability으로만 소통.
 * 기존 runner.ts의 guildId 기반 라우팅을 topic 기반으로 일반���.
 */

/**
 * Topic 문자열 규칙:
 *   {domain}.{action}[.{qualifier}]
 *
 * 예시:
 *   code.review.requested
 *   deploy.completed
 *   jira.ticket.created
 *   report.daily.generated
 */
export type TopicString = string & { readonly __brand: unique symbol };

/** topic 문자열 생성 헬퍼 */
export function topic(value: string): TopicString {
  return value as TopicString;
}

/** topic 패턴 매칭 (와일드카드 지원) */
export function matchTopic(pattern: string, target: TopicString): boolean {
  const patternParts = pattern.split('.');
  const targetParts = (target as string).split('.');

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === '#') return true;  // 나머지 전부 매칭
    if (patternParts[i] === '*') continue;      // 단일 세그먼트 매칭
    if (patternParts[i] !== targetParts[i]) return false;
  }

  return patternParts.length === targetParts.length;
}

/** 잘 알려진 topic 상수 */
export const Topics = {
  // 코드 관련
  CODE_REVIEW_REQUESTED: topic('code.review.requested'),
  CODE_REVIEW_COMPLETED: topic('code.review.completed'),
  CODE_FIX_REQUESTED: topic('code.fix.requested'),
  CODE_FIX_COMPLETED: topic('code.fix.completed'),

  // 배포
  DEPLOY_REQUESTED: topic('deploy.requested'),
  DEPLOY_COMPLETED: topic('deploy.completed'),
  DEPLOY_FAILED: topic('deploy.failed'),

  // Jira
  JIRA_TICKET_CREATED: topic('jira.ticket.created'),
  JIRA_TICKET_UPDATED: topic('jira.ticket.updated'),

  // 보고
  REPORT_REQUESTED: topic('report.requested'),
  REPORT_GENERATED: topic('report.generated'),

  // 일반 작업
  TASK_ASSIGNED: topic('task.assigned'),
  TASK_COMPLETED: topic('task.completed'),
  TASK_FAILED: topic('task.failed'),
} as const;

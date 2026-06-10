/**
 * Transcript V2 — append-only JSONL conversation log with attachment refs.
 *
 * 한 줄 = 한 TranscriptEntry. `type` 필드로 디스크리미네이트.
 *
 * 디자인 원칙:
 *   1. **Discriminated union**: 새 타입 추가가 기존 reader 를 안 깨트림. unknown type 은 skip.
 *   2. **Anthropic SDK 와 정렬된 ContentBlock**: assistant/user 메시지가 tool_use/tool_result 를
 *      1급 시민으로 갖고, LLM 재전송 시 변환비용 0 에 가까움.
 *   3. **Attachment 분리**: 이미지/대용량 바이너리는 transcript 본문에 inline 하지 않음.
 *      `attachment_ref` 만 들고 다님 → LLM 컨텍스트 오염 차단.
 *   4. **Append-only**: 한 줄 깨져도 나머지 살아있음. 가변 메타는 새 줄로 supersede.
 *
 * 의도적으로 트리(parentUuid 분기) 는 V1 에선 도입하되 실제 분기 사용은 보류.
 */

// ── ContentBlock (Anthropic SDK 와 호환) ─────────────────────────────────────

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  /** 짧은 텍스트는 string, 다중 블록은 array. Anthropic SDK 패턴 그대로. */
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}

/**
 * 이미지는 두 가지 source 형태를 지원:
 *   - `attachment_ref`: TranscriptStore.putAttachment 가 반환한 핸들. 디스크에서 lazy 로드.
 *   - `base64`: Anthropic 호환 inline. 작은 이미지/임시 용도에만 사용 권장.
 *   - `url`: 외부 URL. Discord embed 등.
 */
export interface ImageBlock {
  type: 'image';
  source: AttachmentRefSource | Base64ImageSource | UrlImageSource;
}

export interface AttachmentRefSource {
  type: 'attachment_ref';
  /** TranscriptStore.putAttachment 반환값. <uuid>.<ext> 형태. */
  ref: string;
  media_type: string;
}

export interface Base64ImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface UrlImageSource {
  type: 'url';
  url: string;
  media_type?: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

// ── 공통 베이스 ───────────────────────────────────────────────────────────────

export interface TranscriptEntryBase {
  /** 이 엔트리의 ID (v4 UUID). */
  uuid: string;
  /** 직전 엔트리 UUID. `null` 이면 conversation 의 root. */
  parentUuid: string | null;
  /** 대화 식별자 (Discord channelId, session UUID 등). */
  conversationId: string;
  /**
   * 대화가 오간 채널 ('discord' | 'web' | …). 분할 축이 아니라 속성 —
   * 스토어는 채널 무관 통합 저장하고 이 값을 질의 차원으로만 쓴다.
   */
  channel?: string;
  /** ISO8601 timestamp. */
  timestamp: string;
  /** Schema version. 현재 'v2'. 마이그레이션 hook 용. */
  schemaVersion: 'v2';
  /** 임의 메타데이터 (model name, gitBranch, agentId, callId 등). */
  metadata?: Record<string, unknown>;
}

// ── 엔트리 타입 ──────────────────────────────────────────────────────────────

export interface UserTranscriptEntry extends TranscriptEntryBase {
  type: 'user';
  content: ContentBlock[];
}

export interface AssistantTranscriptEntry extends TranscriptEntryBase {
  type: 'assistant';
  content: ContentBlock[];
  /** Model identifier used to produce this turn (e.g. 'claude-opus-4-7'). */
  model?: string;
  /** Token usage if reported by the provider. */
  usage?: TranscriptUsage;
}

export interface TranscriptUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface SystemTranscriptEntry extends TranscriptEntryBase {
  type: 'system';
  /** 사이드 노트, 에러 토스트, 권한 변경 등 인간이 읽는 짧은 텍스트. */
  content: string;
  /** 'info' | 'warn' | 'error' 등 표시 등급. */
  level?: 'info' | 'warn' | 'error';
}

/**
 * Attachment manifest entry — 첨부파일 한 건당 한 줄.
 *
 * 실제 바이너리는 별도 파일 (`<convId>.attachments/<uuid>.<ext>`) 에 저장되고,
 * 이 엔트리는 검색/cleanup/용도 식별을 위한 메타만 보관.
 *
 * 이 엔트리가 transcript 에 존재하지 않아도 `attachment_ref` block 으로
 * 참조하는 건 가능 (manifest 는 best-effort 인덱스).
 */
export interface AttachmentTranscriptEntry extends TranscriptEntryBase {
  type: 'attachment';
  /** TranscriptStore.putAttachment 가 반환한 핸들. */
  ref: string;
  mediaType: string;
  /** 사람이 읽을 파일명 힌트 (없으면 ref 사용). */
  name?: string;
  /** 바이너리 크기 (bytes). */
  size: number;
  /** Optional SHA256 of the bytes. */
  sha256?: string;
}

/**
 * 압축 요약 마커.
 *
 * `supersedesUpToUuid` 이전의 엔트리들이 이 summary 로 대체됨을 의미.
 * Reader 는 summary 를 만나면 이전 엔트리 본문을 건너뛰고 summary 만 컨텍스트에 포함.
 */
export interface SummaryTranscriptEntry extends TranscriptEntryBase {
  type: 'summary';
  summary: string;
  /** 이 UUID 까지 (inclusive) 의 엔트리가 summary 로 대체됨. */
  supersedesUpToUuid: string;
}

export type TranscriptEntry =
  | UserTranscriptEntry
  | AssistantTranscriptEntry
  | SystemTranscriptEntry
  | AttachmentTranscriptEntry
  | SummaryTranscriptEntry;

// ── Store port ───────────────────────────────────────────────────────────────

export interface AttachmentRef {
  ref: string;
  mediaType: string;
  size: number;
  name?: string;
}

export interface TranscriptStore {
  /**
   * Append a single entry. Implementations may batch writes internally; callers
   * should not assume the entry is fsync'd on resolution. Call `flush()` for
   * durability guarantees.
   */
  appendEntry(entry: TranscriptEntry): Promise<void>;

  /** Force a flush of any pending writes. */
  flush(): Promise<void>;

  /**
   * Stream entries for a conversation in insertion order.
   * If `limit` is provided, the last N entries are yielded (newest tail).
   */
  getEntries(conversationId: string, opts?: { limit?: number }): AsyncIterable<TranscriptEntry>;

  /** Store a binary blob and return a handle (`ref`) usable in attachment_ref blocks. */
  putAttachment(
    conversationId: string,
    data: Buffer,
    mediaType: string,
    name?: string,
  ): Promise<AttachmentRef>;

  /** Resolve an attachment ref to its bytes. Returns null when missing. */
  getAttachment(conversationId: string, ref: string): Promise<Buffer | null>;

  /** Delete a conversation's transcript and all attachments. */
  deleteConversation(conversationId: string): Promise<void>;
}

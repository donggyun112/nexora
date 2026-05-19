# ADR-003: Postgres + pgvector (별도 vector DB X)

**상태**: Accepted
**날짜**: 2026-05-13

## 컨텍스트

플랫폼은 테넌트·카탈로그·Skills·세션·audit + 임베딩 / 벡터 검색 필요.

## 검토한 옵션

- **Postgres + pgvector**: 단일 DB, 트랜잭션 가능, 운영 부담 적음.
- **Postgres + 별도 vector DB (Pinecone/Weaviate/Qdrant)**: 벡터 성능 최적. 단 두 DB 동기화 + 두 시스템 운영.
- **별도 vector DB 단독 (Weaviate as primary)**: 작은 데이터에 ACID 부재.

## 결정

**Postgres + pgvector** — v0/v1엔 충분.

이유:
1. v0/v1 데이터 규모(수만 임베딩)에서 pgvector 성능 충분
2. 트랜잭션이 같은 DB에서 가능 (manifest 등록 + 임베딩 작성을 한 tx로)
3. 운영 단순 — 백업·복구·모니터링 1개 시스템
4. 비용 — 별도 vector DB 청구 안 함

v2+에서 데이터 폭발 시 (>10M 임베딩) 별도 vector DB 검토.

## 결과

긍정:
- 단일 source of truth
- pgx/v5 + pgvector-go 검증된 조합
- IVFFlat / HNSW 인덱스로 ANN 적절히 빠름

부정:
- 매우 큰 데이터셋에선 별도 vector DB 대비 느림
- 벡터 + JSON + 일반 쿼리가 같은 DB에서 경합 가능

## 관련 결정

- 임베딩 모델: OpenAI text-embedding-3-small (1536 차원) 기본 — tenant가 BYOM 가능
- 인덱스: IVFFlat 초기, 데이터 증가 시 HNSW
- 청크 크기: 토큰 512~1024 (Skill 본문 단위)

## 안 가는 길

- **Pinecone**: 비싸고 락인. v0/v1 비용 정당화 안 됨.
- **Weaviate**: 좋은 OSS이지만 운영 추가. ACID 결여.
- **Qdrant**: Rust 기반 OSS. 운영 추가 부담. v2+에서 재검토 가능.

## 관련

- [data/postgres-schema.md](../data/postgres-schema.md)
- [stack/infrastructure.md](../stack/infrastructure.md)

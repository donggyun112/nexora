/**
 * egress-proxy — overlay 백엔드용 allowlist CONNECT 포워드 프록시.
 *
 * overlay 잽은 `--unshare-net` 이라 외부 경로가 없다. 유일한 egress 는 잽 안 socat 이
 * `127.0.0.1:3128` → bind-mount 된 유닉스소켓으로 포워딩하는 경로뿐이고, 이 프록시가 그
 * 유닉스소켓에 listen 한다. CONNECT 대상 호스트를 allowlist(suffix-match)로 검사해 통과분만
 * 터널링하고 나머지는 403. 잽 netns 엔 이 소켓 외 경로가 물리적으로 없으므로, 프롬프트
 * 인젝션된 프로세스도 allowlist 밖으로 데이터를 뺄 수 없다.
 *
 * 호스트네임만 필터(CONNECT 대상), TLS MITM 없음 — 경로/헤더가 아니라 목적지 도메인만 통제.
 */
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';

export interface EgressProxyOptions {
  /** 유닉스소켓 경로. 잽에 bind-mount 되어 잽 안 socat 이 여기로 붙는다. */
  socketPath: string;
  /** 통과 허용 도메인(suffix-match). 비면 전부 차단. */
  allowedDomains: string[];
  /** 명시 차단 도메인(allow 보다 우선). */
  deniedDomains?: string[];
}

export interface EgressProxyHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * 호스트가 패턴에 매칭되면 true. 정확히 일치하거나 패턴의 하위 도메인(`.pattern` 접미)일 때.
 * `*.example.com` 은 `example.com` 접미와 동치로 취급한다.
 */
export function matchesDomainPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().replace(/^\*\./, '');
  if (!p) return false;
  return h === p || h.endsWith(`.${p}`);
}

/**
 * CONNECT 대상 호스트가 egress 허용인지. 먼저 호스트를 canonicalize 하고 hostname 문자만
 * 허용해(IP shorthand·null-byte·인코딩 트릭 방어) deny 우선 검사 후 allow suffix-match.
 * 숫자 IP 는 `.domain` 접미에 안 걸리므로 자연히 거부된다.
 */
export function isEgressAllowed(host: string, allowed: string[], denied: string[] = []): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h || !/^[a-z0-9.-]+$/.test(h) || h.includes('..')) return false;
  if (denied.some((d) => matchesDomainPattern(h, d))) return false;
  return allowed.some((a) => matchesDomainPattern(h, a));
}

/** `host:port` authority 를 파싱. IPv6 대괄호와 포트 범위를 검증한다. */
function parseConnectTarget(authority: string): { host: string; port: number } | null {
  const trimmed = authority.trim();
  const idx = trimmed.lastIndexOf(':');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  const host = trimmed.slice(0, idx);
  const port = Number(trimmed.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * 유닉스소켓에 listen 하는 allowlist CONNECT 프록시를 기동한다. 반환 핸들의 close() 로
 * 서버 종료 + 소켓 파일 정리.
 */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxyHandle> {
  const allowed = options.allowedDomains ?? [];
  const denied = options.deniedDomains ?? [];
  // stale 소켓 제거 — listen 이 EADDRINUSE 로 실패하지 않게.
  await fsp.rm(options.socketPath, { force: true });

  const server = http.createServer((_req, res) => {
    // 이 프록시는 CONNECT(https 터널)만 지원한다 — 평문 HTTP 프록시는 거부.
    res.writeHead(405, { 'content-type': 'text/plain' }).end('egress-proxy: only CONNECT is supported\n');
  });

  server.on('connect', (req, clientSocket, head) => {
    const target = parseConnectTarget(req.url ?? '');
    if (!target || !isEgressAllowed(target.host, allowed, denied)) {
      clientSocket.write(
        'HTTP/1.1 403 Forbidden\r\nX-Proxy-Error: blocked-by-allowlist\r\nConnection: close\r\n\r\n',
      );
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(target.port, target.host, () => {
      clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const kill = (): void => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', kill);
    clientSocket.on('error', kill);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    socketPath: options.socketPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fsp.rm(options.socketPath, { force: true });
    },
  };
}

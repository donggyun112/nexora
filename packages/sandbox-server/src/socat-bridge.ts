/**
 * socat-bridge — 두 샌드박스 백엔드(bwrap, gVisor)가 공유하는 network:'proxy' egress 배선.
 *
 * 잽은 net 을 완전히 unshare 한다(bwrap `--unshare-net` / gVisor `--network=none`). 유일한
 * egress 경로는 호스트측 allowlist 프록시(또는 auth-injecting 게이트웨이)가 listen 하는
 * 유닉스소켓을 잽에 bind-mount 하는 것뿐이다. 그런데 대부분의 HTTP 클라이언트(undici 등)는
 * `HTTPS_PROXY`/`ANTHROPIC_BASE_URL` 에 유닉스소켓 경로가 아니라 TCP 오리진을 기대하므로,
 * 잽 **내부**에서 loopback TCP → bind-mount 된 유닉스소켓을 잇는 `socat` 브리지를 띄운다.
 *
 * 순수 모듈 — I/O 없음. `buildBwrapArgs`/`buildOciConfig` 양쪽 다 이 배선을 그대로 재사용하면서
 * "spec/args 빌더는 순수 함수" 라는 각자의 purity contract 를 유지할 수 있다.
 */

// egress: 잽 안 socat 이 loopback:PROXY_LISTEN_PORT → bind-mount 된 유닉스소켓
// (EGRESS_SOCK_IN_JAIL) 으로 포워딩하고, 호스트측 allowlist CONNECT 프록시가 그 소켓에 listen 한다.
export const EGRESS_SOCK_IN_JAIL = '/run/nexora/egress.sock';
export const PROXY_LISTEN_PORT = 3128;
export const PROXY_URL_IN_JAIL = `http://127.0.0.1:${PROXY_LISTEN_PORT}`;

// auth-injecting 게이트웨이: 같은 패턴. 잽 안 loopback:GW_LISTEN_PORT 를 호스트측 대화별
// 게이트웨이 유닉스소켓(GW_SOCK_IN_JAIL)에 연결한다. ANTHROPIC_BASE_URL 을 이 loopback 으로
// 설정하면 claude 가 자동으로 게이트웨이를 거치게 된다.
export const GW_SOCK_IN_JAIL = '/run/nexora/gateway.sock';
export const GW_LISTEN_PORT = 3129;
export const GW_BASE_URL_IN_JAIL = `http://127.0.0.1:${GW_LISTEN_PORT}`;

export type LoopbackBridge = { listenPort: number; socketInJail: string };

/**
 * `bridges` 각 항목마다 `127.0.0.1:listenPort` → `socketInJail` 유닉스소켓을 잇는 socat
 * 백그라운드 프로세스를 띄우고, 각 브리지가 실제로 연결을 받을 때까지 짧게 폴링한 뒤
 * 실 명령(`"$@"`)을 실행, 종료 시 모든 브리지 프로세스를 정리하고 그 종료코드로 exit 한다.
 * 순수 문자열 생성 함수 — I/O 없음(양쪽 백엔드의 spec/args 빌더 purity contract 대상).
 */
export function loopbackBridgeScript(bridges: LoopbackBridge[]): string {
  const starts = bridges
    .map(
      (b) =>
        `socat TCP-LISTEN:${b.listenPort},fork,reuseaddr,bind=127.0.0.1 ` +
        `UNIX-CONNECT:${b.socketInJail} >/dev/null 2>&1 & _p${b.listenPort}=$!;`,
    )
    .join(' ');
  const waits = bridges
    .map(
      (b) =>
        `for _i in 1 2 3 4 5 6 7 8 9 10; do ` +
        `socat -u OPEN:/dev/null TCP:127.0.0.1:${b.listenPort} >/dev/null 2>&1 && break; ` +
        `sleep 0.1; done;`,
    )
    .join(' ');
  const kills = bridges.map((b) => `kill $_p${b.listenPort} >/dev/null 2>&1;`).join(' ');
  return `${starts} ${waits} "$@"; _rc=$?; ${kills} exit $_rc`;
}

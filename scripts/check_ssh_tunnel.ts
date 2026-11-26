/**
 * SSH 터널이 끊겨도 메모리 프로그램이 죽지 않고 다시 붙는지 (2026-11-26 맥북 클로드 데스크톱 "Connection closed").
 *
 * 필요: CHECK_TUNNEL_DATABASE_URL — 일회용 Postgres(쓰기 없음, SELECT 1 만). 없으면 건너뛴다.
 *
 * 이 스크립트 안에서 ssh2 SSH 서버(가짜 몰타르)와 그 앞에 TCP 중계(멈춤 가능)를 띄우고, 자식 프로세스
 * (check_ssh_tunnel_driver)가 src/db.ts 로 그 서버를 거쳐 DB 에 붙는다. 자식이 죽으면 exit code·stderr 로 잡는다.
 *
 *  1. 깨끗한 끊김: 서버가 SSH 를 닫고 → 풀이 놀던 연결을 버릴 때(30초)보다 오래 기다린 뒤 query.
 *     옛 코드: tunnel-ssh 의 연결 처리기에서 forwardOut 이 "Not connected" 를 던져 프로세스가 죽는다(음성대조).
 *  2. 빌린 연결이 있는 채 끊김: getClient() 로 쥔 연결이 죽어도 프로세스가 산다.
 *  3. 소리 없는 멈춤(FIN 없음): 중계를 얼려 keepalive 로만 알 수 있게 → query 가 끝없이 매달리지 않고 실패,
 *     풀린 뒤 다시 붙는다.
 *  4. 서버 지문(SSH_HOST_FINGERPRINT): 틀리면 붙지 않고, 맞으면 붙는다.
 *  5. DB 쪽이 놀던 연결을 끊어도(Postgres 재시작 등) 프로세스가 산다.
 *  6. SSH 인증 도중 서버가 정상 종료해도 연결 대기가 끝나고, 다음 요청이 새로 붙는다.
 *
 * SKIP_SLOW=1 이면 30초 기다리는 1번을 짧게(5초) 돌린다 — 그때는 옛 코드의 죽음을 재현하지 못한다.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";

const { Server, utils } = ssh2 as any;

const dbUrl = process.env.CHECK_TUNNEL_DATABASE_URL;
if (!dbUrl) {
  console.log("(CHECK_TUNNEL_DATABASE_URL 없음 — SSH 터널 검사는 건너뜀)");
  process.exit(0);
}
const dbu = new URL(dbUrl);
const DB = {
  host: dbu.hostname, port: Number(dbu.port || 5432),
  user: decodeURIComponent(dbu.username), pass: decodeURIComponent(dbu.password), name: dbu.pathname.slice(1),
};
const DRIVER = path.resolve(process.env.CHECK_TUNNEL_DRIVER ?? "node_modules/.cache/mcp-agents-memory/check_ssh_tunnel_driver.mjs");
assert.ok(fs.existsSync(DRIVER), `driver 번들이 없다: ${DRIVER}`);
const IDLE_WAIT_MS = process.env.SKIP_SLOW === "1" ? 5_000 : 33_000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mam-sshtun-"));
const hostKey = utils.generateKeyPairSync("ed25519");
const clientKey = utils.generateKeyPairSync("ed25519");
const clientPubBlob: Buffer = utils.parseKey(clientKey.public).getPublicSSH();
const hostPubBlob: Buffer = utils.parseKey(hostKey.public).getPublicSSH();
const FINGERPRINT = "SHA256:" + crypto.createHash("sha256").update(hostPubBlob).digest("base64").replace(/=+$/, "");
const keyFile = path.join(tmp, "client_key");
fs.writeFileSync(keyFile, clientKey.private, { mode: 0o600 });

// ── 가짜 몰타르 SSH 서버: 이 열쇠만 받고, direct-tcpip 를 DB 로만 넘긴다 ──
let authCount = 0;
let endDuringAuth = 0;
const sshClients = new Set<any>();
const sshServer = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
  sshClients.add(client);
  client.on("close", () => sshClients.delete(client));
  client.on("error", () => {});
  client.on("authentication", (ctx: any) => {
    if (endDuringAuth > 0) { endDuringAuth--; client.end(); return; } // 인증 중 서버가 정상 종료
    if (ctx.method === "publickey" && ctx.key.algo === "ssh-ed25519" && Buffer.compare(ctx.key.data, clientPubBlob) === 0) {
      if (ctx.signature) authCount++;
      return ctx.accept();
    }
    ctx.reject(["publickey"]);
  });
  client.on("ready", () => {
    client.on("tcpip", (accept: any, reject: any, info: any) => {
      if (info.destPort !== DB.port) return reject();
      const ch = accept();
      const up = net.connect(DB.port, DB.host);
      up.on("error", () => ch.destroy());
      ch.on("error", () => up.destroy());
      ch.pipe(up).pipe(ch);
    });
  });
});
await new Promise<void>((r) => sshServer.listen(0, "127.0.0.1", r));
const sshPort = (sshServer.address() as net.AddressInfo).port;

// ── 중계: 클라이언트 ↔ SSH 서버. freeze() 하면 FIN 없이 양쪽을 멈춘다 ──
let frozen = false;
const relays = new Set<{ a: net.Socket; b: net.Socket }>();
const relay = net.createServer((a) => {
  const b = net.connect(sshPort, "127.0.0.1");
  const pair = { a, b };
  relays.add(pair);
  const drop = () => { relays.delete(pair); a.destroy(); b.destroy(); };
  a.on("error", drop); b.on("error", drop); a.on("close", drop); b.on("close", drop);
  a.on("data", (d) => { if (!frozen) b.write(d); });
  b.on("data", (d) => { if (!frozen) a.write(d); });
});
await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
const relayPort = (relay.address() as net.AddressInfo).port;

function writeEnv(extra: Record<string, string>): string {
  const env: Record<string, string> = {
    SSH_ENABLED: "true", SSH_HOST: "127.0.0.1", SSH_PORT: String(relayPort), SSH_USER: "memtest",
    SSH_KEY_PATH: keyFile, DB_HOST: DB.host, DB_PORT: String(DB.port), DB_USER: DB.user, DB_PASS: DB.pass, DB_NAME: DB.name,
    SSH_KEEPALIVE_INTERVAL_MS: "1000", SSH_KEEPALIVE_COUNT_MAX: "2",
    ...extra,
  };
  const f = path.join(tmp, `env-${crypto.randomBytes(4).toString("hex")}.env`);
  fs.writeFileSync(f, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  return f;
}

class Driver {
  proc: ChildProcessWithoutNullStreams;
  lines: string[] = [];
  stderr = "";
  exit: number | null | undefined = undefined;
  private waiters: Array<(l: string) => void> = [];
  constructor(envFile: string) {
    this.proc = spawn(process.execPath, [DRIVER], {
      cwd: tmp, env: { PATH: process.env.PATH ?? "", HOME: tmp, MEMORY_CONFIG_PATH: envFile },
    });
    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(l); else this.lines.push(l);
      }
    });
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
    this.proc.on("exit", (code) => {
      this.exit = code;
      for (const w of this.waiters.splice(0)) w(`exited ${code}`);
    });
  }
  next(timeoutMs = 30_000): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.exit !== undefined) return Promise.resolve(`exited ${this.exit}`);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve("timeout"), timeoutMs);
      this.waiters.push((l) => { clearTimeout(t); resolve(l); });
    });
  }
  async cmd(c: string, timeoutMs?: number): Promise<string> {
    if (this.exit !== undefined) return `exited ${this.exit}`;
    this.proc.stdin.write(c + "\n");
    return this.next(timeoutMs);
  }
  async stop() {
    if (this.exit === undefined) { await this.cmd("close", 10_000); }
    if (this.exit === undefined) this.proc.kill("SIGKILL");
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const killSsh = () => { for (const c of sshClients) c.end(); };
const results: string[] = [];
const report = (name: string, ok: boolean, detail: string) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

try {
  // ── 1. 깨끗한 끊김 → 놀던 연결이 버려질 만큼 기다림 → query ──
  {
    const d = new Driver(writeEnv({ SSH_HOST_FINGERPRINT: FINGERPRINT }));
    assert.equal(await d.next(), "ready");
    const a0 = authCount;
    const q1 = await d.cmd("query");
    killSsh();
    await sleep(IDLE_WAIT_MS);
    const q2 = await d.cmd("query", 20_000);
    const alive = d.exit === undefined;
    report("1 clean close + idle wait", q1 === "ok 1" && q2 === "ok 1" && alive,
      `first=${q1} after=${q2} alive=${alive} reauth=${authCount - a0} ${alive ? "" : "stderr=" + d.stderr.split("\n").filter((l) => /Error|Not connected/.test(l)).slice(0, 2).join(" | ")}`);
    await d.stop();
  }

  // ── 1b. 실제 사고 순서: 놀던 연결이 버려진 뒤(30초+) SSH 가 끊기고 → 새 연결 ──
  //      옛 코드는 여기서 tunnel-ssh 의 forwardOut 이 "Not connected" 를 던져 죽는다(11-26 맥북 로그와 같은 자리).
  {
    const d = new Driver(writeEnv({ SSH_HOST_FINGERPRINT: FINGERPRINT }));
    assert.equal(await d.next(), "ready");
    const q1 = await d.cmd("query");
    await sleep(IDLE_WAIT_MS);
    killSsh();
    await sleep(1_000);
    const q2 = await d.cmd("query", 20_000);
    const alive = d.exit === undefined;
    report("1b idle-closed then ssh close (incident order)", q1 === "ok 1" && q2 === "ok 1" && alive,
      `first=${q1} after=${q2} alive=${alive} ${alive ? "" : "stderr=" + d.stderr.split("\n").filter((l) => /Error|Not connected/.test(l)).slice(0, 2).join(" | ")}`);
    await d.stop();
  }

  // ── 2. 빌린 연결을 쥔 채 끊김 ──
  {
    const d = new Driver(writeEnv({ SSH_HOST_FINGERPRINT: FINGERPRINT }));
    assert.equal(await d.next(), "ready");
    const h = await d.cmd("hold");
    killSsh();
    await sleep(2_000);
    const aliveAfterKill = d.exit === undefined;
    const r = await d.cmd("release");
    const q = await d.cmd("query", 20_000);
    report("2 checked-out client + close", h === "held" && aliveAfterKill && q === "ok 1",
      `hold=${h} aliveAfterKill=${aliveAfterKill} release=${r} after=${q}`);
    await d.stop();
  }

  // ── 3. 소리 없는 멈춤 → keepalive 로 알아채고, 풀리면 다시 붙음 ──
  {
    const d = new Driver(writeEnv({ SSH_HOST_FINGERPRINT: FINGERPRINT }));
    assert.equal(await d.next(), "ready");
    const q1 = await d.cmd("query");
    frozen = true;
    const t0 = Date.now();
    const q2 = await d.cmd("query", 40_000);
    const stallMs = Date.now() - t0;
    // 얼린 연결은 버리고 새 연결은 통하게
    for (const p of relays) { p.a.destroy(); p.b.destroy(); }
    frozen = false;
    const q3 = await d.cmd("query", 20_000);
    const alive = d.exit === undefined;
    report("3 silent stall", q1 === "ok 1" && q2.startsWith("err") && q3 === "ok 1" && alive,
      `first=${q1} during=${q2.slice(0, 60)} (${stallMs}ms) after=${q3} alive=${alive}`);
    await d.stop();
  }

  // ── 5. DB 쪽이 놀던 연결을 끊음(Postgres 재시작·관리자 종료) — SSH 는 멀쩡함 ──
  //      풀의 놀던 연결이 'error' 를 내는데 받을 곳이 없으면 프로세스가 죽는다.
  {
    const d = new Driver(writeEnv({ SSH_HOST_FINGERPRINT: FINGERPRINT }));
    assert.equal(await d.next(), "ready");
    const q1 = await d.cmd("query");
    const pg = (await import("pg")).default;
    const admin = new pg.Client({ connectionString: dbUrl });
    await admin.connect();
    const killed = (await admin.query(
      `SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle') t`)).rows[0].n;
    await admin.end();
    await sleep(1_500);
    const aliveAfter = d.exit === undefined;
    const q2 = await d.cmd("query", 20_000);
    report("5 db-side terminate idle", q1 === "ok 1" && killed >= 1 && aliveAfter && q2 === "ok 1",
      `first=${q1} terminated=${killed} aliveAfter=${aliveAfter} after=${q2} ${aliveAfter ? "" : "stderr=" + d.stderr.split("\n").filter((l) => /Error/.test(l)).slice(0, 1).join("")}`);
    await d.stop();
  }

  // ── 6. 인증 도중 서버가 정상 종료(코디 #48 재현) → 첫 query 가 끝없이 매달리지 않고, 다음 query 는 새로 시도 ──
  {
    const d = new Driver(writeEnv({ SSH_HOST_FINGERPRINT: FINGERPRINT }));
    assert.equal(await d.next(), "ready");
    endDuringAuth = 1;
    const t0 = Date.now();
    const q1 = await d.cmd("query", 30_000);
    const waitMs = Date.now() - t0;
    const q2 = await d.cmd("query", 20_000);
    const alive = d.exit === undefined;
    report("6 server ends during auth", q1.startsWith("err") && q2 === "ok 1" && alive,
      `first=${q1.slice(0, 70)} (${waitMs}ms) retry=${q2} alive=${alive}`);
    endDuringAuth = 0;
    await d.stop();
  }

  // ── 4. 서버 지문 ──
  {
    const wrong = new Driver(writeEnv({ SSH_HOST_FINGERPRINT: "SHA256:" + "A".repeat(43) }));
    assert.equal(await wrong.next(), "ready");
    const a0 = authCount;
    const qw = await wrong.cmd("query", 20_000);
    const wrongAlive = wrong.exit === undefined;
    await wrong.stop();
    const wrongAuth = authCount - a0; // 지문이 틀리면 열쇠 인증까지 가면 안 된다
    const right = new Driver(writeEnv({ SSH_HOST_FINGERPRINT: `SHA256:${"B".repeat(43)}, ${FINGERPRINT}` }));
    assert.equal(await right.next(), "ready");
    const qr = await right.cmd("query", 20_000);
    await right.stop();
    const unset = new Driver(writeEnv({}));
    assert.equal(await unset.next(), "ready");
    const qu = await unset.cmd("query", 20_000);
    await unset.stop();
    const warned = /SSH_HOST_FINGERPRINT/.test(unset.stderr);
    report("4 host fingerprint",
      qw.startsWith("err") && /fingerprint/i.test(qw) && wrongAlive && wrongAuth === 0 && qr === "ok 1" && qu === "ok 1" && warned,
      `wrong=${qw.slice(0, 80)} alive=${wrongAlive} authAfterWrong=${wrongAuth} list=${qr} unset=${qu} warn=${warned}`);
  }
} finally {
  for (const p of relays) { p.a.destroy(); p.b.destroy(); }
  relay.close();
  for (const c of sshClients) c.end();
  sshServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith("FAIL"));
if (failed.length) {
  console.error(`❌ check:ssh-tunnel — ${failed.length} 실패`);
  process.exit(1);
}
console.log("ssh tunnel resilience checks passed");

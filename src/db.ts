import pg from 'pg';
import { Client as SshClient } from 'ssh2';
import crypto from 'crypto';
import net from 'net';
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────
// Config (.env) loading
// Search order — first valid hit wins (file must exist AND contain DB creds):
//   1. MEMORY_CONFIG_PATH (explicit override)
//   2. process.cwd()/.env  (project-local — preserves dev workflow)
//   3. ~/.config/mcp-agents-memory/.env  (XDG, where the wizard writes)
//   4. __dirname/../.env  (legacy fallback inside the package)
//
// "Valid" = parsed file contains DATABASE_URL or DB_HOST.
// This prevents stray home-dir .env files (e.g. one containing only SUDO_PASSWORD)
// from silently shadowing the real config.
// ─────────────────────────────────────────────────────────────

export function configSearchPaths(): string[] {
  const paths: string[] = [];
  if (process.env.MEMORY_CONFIG_PATH) paths.push(process.env.MEMORY_CONFIG_PATH);
  paths.push(path.resolve(process.cwd(), '.env'));
  paths.push(path.join(os.homedir(), '.config', 'mcp-agents-memory', '.env'));
  paths.push(path.resolve(__dirname, '..', '.env'));
  return paths;
}

let envLoadedFrom: string | null = null;

export function loadEnv(): string | null {
  if (envLoadedFrom) return envLoadedFrom;
  for (const candidate of configSearchPaths()) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = dotenv.parse(fs.readFileSync(candidate, 'utf-8'));
    if (!parsed.DATABASE_URL && !parsed.DB_HOST) continue; // skip non-DB .env files
    dotenv.config({ path: candidate });
    envLoadedFrom = candidate;
    return candidate;
  }
  return null;
}

/**
 * import 시점 설정 읽기 실패(권한 없음 등). `mcp-agents-memory hook …` 만 이걸 들고 계속 간다 —
 * 훅은 늘 exit 0 이어야 하는데 이 줄이 훅 코드보다 먼저 돈다. 훅은 이 값이 있으면 DB 에 붙기 전에 끝낸다.
 */
export let envLoadError: Error | null = null;
try {
  loadEnv();
} catch (err) {
  // 훅 말고는(서버·migrate·스크립트) 예전처럼 여기서 멈춘다. 이어 가면 환경변수에 남은 DATABASE_URL 로
  // 엉뚱한 DB 에 쓸 수 있다(코디 재현: 읽을 수 없는 설정 + 상속 DATABASE_URL → migrate 가 그 DB 에 적용).
  if (process.argv[2] !== "hook") throw err;
  envLoadError = err instanceof Error ? err : new Error(String(err));
}

// ─────────────────────────────────────────────────────────────
// Pool config
// Precedence: DATABASE_URL > legacy DB_HOST/PORT/USER/PASS/NAME.
// SSL: enabled when DATABASE_URL contains sslmode=require OR DB_SSL=true.
// ─────────────────────────────────────────────────────────────

const { Pool } = pg;

interface PoolConfigResult {
  config: pg.PoolConfig;
  description: string;
}

export function buildPoolConfig(): PoolConfigResult {
  const url = process.env.DATABASE_URL;
  const sslWanted =
    (url && /[?&]sslmode=require\b/.test(url)) || process.env.DB_SSL === 'true';
  const ssl = sslWanted ? { rejectUnauthorized: false } : undefined;

  if (url) {
    return {
      config: { connectionString: url, ssl, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 },
      description: `DATABASE_URL${sslWanted ? ' (ssl)' : ''}`,
    };
  }

  if (!process.env.DB_HOST || !process.env.DB_NAME) {
    throw new Error(
      'Database not configured. Set DATABASE_URL (e.g. postgres://user:pass@host:5432/db?sslmode=require) ' +
      'or DB_HOST + DB_USER + DB_PASS + DB_NAME. Run `mcp-agents-memory setup` to generate a config.'
    );
  }

  return {
    config: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      ssl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    },
    description: `${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME}${sslWanted ? ' (ssl)' : ''}`,
  };
}

// ─────────────────────────────────────────────────────────────
// SSH tunnel helpers
// 2026-11-26 맥북 클로드 데스크톱: 터널이 열린 뒤 SSH 가 끊기면 tunnel-ssh 5.2.0 은 오류를 삼키고 로컬 입구만
// 열어 둔다 → 다음 새 DB 연결에서 forwardOut 이 "Not connected" 를 던져 프로세스가 죽었다. 그래서 ssh2 로 직접
// 포워딩하고(오류는 그 연결만 닫는다), 끊기면 터널·풀을 비워 다음 DB 요청 때 다시 연다.
// ─────────────────────────────────────────────────────────────

/** keepalive — 조용한 통로를 공유기가 끊지 않게, 끊긴 통로는 interval × (countMax+1) 안에 알아챈다. */
export function sshKeepaliveSettings(env: NodeJS.ProcessEnv = process.env): { keepaliveInterval: number; keepaliveCountMax: number } {
  const num = (v: string | undefined, d: number, min: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : d;
  };
  return {
    keepaliveInterval: num(env.SSH_KEEPALIVE_INTERVAL_MS, 15_000, 500),
    keepaliveCountMax: num(env.SSH_KEEPALIVE_COUNT_MAX, 3, 1),
  };
}

/**
 * SSH_HOST_FINGERPRINT — 서버 호스트 키 지문(ssh-keygen -lf 의 "SHA256:…"). 쉼표로 여러 개(키 종류별).
 * 비어 있으면 [] → 서버 확인을 못 한다(경고).
 */
export function parseHostFingerprints(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.replace(/^SHA256:/i, "").replace(/=+$/, ""));
}

/** 서버가 보낸 호스트 키(원본 blob)가 고정한 지문 중 하나와 같은가. */
export function hostKeyMatches(key: Buffer, pins: string[]): boolean {
  const fp = crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  return pins.includes(fp);
}

let _warnedNoFingerprint = false;

export class DatabaseManager {
  private static instance: DatabaseManager;
  private pool: pg.Pool | null = null;
  private tunnelServer: net.Server | null = null;
  private sshConn: SshClient | null = null;
  /** 지금 살아 있는 터널의 번호. 옛 터널의 close 이벤트가 새 터널을 지우지 않게 맞춰 본다. */
  private tunnelGen = 0;
  private connectPromise: Promise<pg.Pool> | null = null;
  /** getClient() 로 빌려 준 연결 — 쓰는 중에 소켓이 죽어도 'error' 를 받을 곳이 있어야 프로세스가 안 죽는다. */
  private guardedClients = new WeakSet<pg.PoolClient>();

  private constructor() { }

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  public async connect(): Promise<pg.Pool> {
    if (this.pool) return this.pool;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        const useSSH = process.env.SSH_ENABLED === 'true';
        if (useSSH) return await this.openSshPool();

        const { config, description } = buildPoolConfig();
        const pool = new Pool(config);
        guardPool(pool);
        await pool.query('SELECT 1');
        console.error(`✅ Database connected — ${description}`);
        this.pool = pool;
        return pool;
      } catch (err) {
        this.connectPromise = null;
        throw err;
      }
    })();

    return this.connectPromise;
  }

  /** ssh2 로 직접 포워딩하는 풀을 연다. 실패하면 연 것을 다 닫고 던진다. */
  private async openSshPool(): Promise<pg.Pool> {
    const gen = ++this.tunnelGen;
    const pins = parseHostFingerprints(process.env.SSH_HOST_FINGERPRINT);
    if (pins.length === 0 && !_warnedNoFingerprint) {
      _warnedNoFingerprint = true;
      console.error("⚠️ SSH_HOST_FINGERPRINT is not set — the SSH server's identity is not verified. "
        + "Set it to the server's host key fingerprint (ssh-keygen -lf, \"SHA256:…\"; comma-separate several).");
    }
    const dstAddr = process.env.DB_HOST || 'localhost';
    const dstPort = parseInt(process.env.DB_PORT || '5432');
    let hostKeyRejected = false;

    console.error("🔑 Establishing SSH Tunnel...");
    const conn = new SshClient();
    let dead = false;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        conn.removeListener('ready', onReady);
        conn.on('error', () => { /* 실패한 연결의 뒤늦은 오류 — 받을 곳이 없으면 프로세스가 죽는다 */ });
        conn.end();
        reject(hostKeyRejected
          ? new Error(`SSH host key does not match SSH_HOST_FINGERPRINT — refusing to connect to ${process.env.SSH_HOST}`)
          : err);
      };
      const onReady = () => { conn.removeListener('error', onError); resolve(); };
      conn.once('error', onError);
      conn.once('ready', onReady);
      try {
        conn.connect({
          host: process.env.SSH_HOST,
          port: parseInt(process.env.SSH_PORT || '22'),
          username: process.env.SSH_USER,
          privateKey: fs.readFileSync(path.resolve(process.cwd(), process.env.SSH_KEY_PATH || '')),
          passphrase: process.env.SSH_PASS,
          readyTimeout: 20_000,
          ...sshKeepaliveSettings(),
          ...(pins.length > 0
            ? { hostVerifier: (key: Buffer) => { const ok = hostKeyMatches(key, pins); if (!ok) hostKeyRejected = true; return ok; } }
            : {}),
        } as any);
      } catch (err) {
        conn.removeListener('ready', onReady);
        conn.removeListener('error', onError);
        conn.on('error', () => { /* 위와 같은 이유 */ });
        reject(err);
      }
    });

    // 연결이 사는 동안 늘 붙어 있는 처리기 — keepalive 시간 초과도 'error' 로 온다
    conn.on('error', (err) => {
      console.error(`⚠️ SSH tunnel error: ${err.message}`);
      dead = true;
      this.dropTunnel(gen, 'ssh error');
    });
    conn.on('close', () => {
      dead = true;
      this.dropTunnel(gen, 'ssh closed');
    });

    const server = net.createServer((sock) => {
      sock.on('error', () => { /* 앱 쪽 연결 오류 — 이 연결만 닫힌다 */ });
      if (dead || gen !== this.tunnelGen) { sock.destroy(); return; }
      try {
        conn.forwardOut('127.0.0.1', sock.remotePort ?? 0, dstAddr, dstPort, (err, stream) => {
          if (err) { console.error(`⚠️ SSH forward failed: ${err.message}`); sock.destroy(); return; }
          stream.on('error', () => sock.destroy());
          sock.on('close', () => stream.destroy());
          stream.on('close', () => sock.destroy());
          sock.pipe(stream).pipe(sock);
        });
      } catch (err: any) {
        // 끊긴 SSH 에 forwardOut 하면 동기로 던진다 — 이 연결만 닫고 터널을 비운다
        console.error(`⚠️ SSH forward failed: ${err?.message ?? err}`);
        sock.destroy();
        dead = true;
        this.dropTunnel(gen, 'forward failed');
      }
    });
    server.on('error', (err) => console.error(`⚠️ SSH tunnel listener error: ${err.message}`));

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      const localPort = (server.address() as net.AddressInfo).port;
      console.error(`✅ SSH Tunnel established on local port ${localPort}`);

      const pool = new Pool({
        host: '127.0.0.1',
        port: localPort,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
      guardPool(pool);
      try {
        await pool.query('SELECT 1');
      } catch (err) {
        console.error("❌ Database connection probe failed:", err);
        pool.end().catch(() => {});
        throw err;
      }
      if (dead || gen !== this.tunnelGen) {
        pool.end().catch(() => {});
        throw new Error('SSH tunnel closed while connecting');
      }
      console.error("✅ Database connection verified.");
      this.pool = pool;
      this.tunnelServer = server;
      this.sshConn = conn;
      return pool;
    } catch (err) {
      server.close();
      conn.end();
      throw err;
    }
  }

  /**
   * SSH 가 끊겼을 때 — 프로그램은 살리고 터널·풀만 비운다. 다음 DB 요청이 connect() 로 새로 연다.
   * 옛 터널(gen 이 다름)의 이벤트는 무시한다. pool.end() 를 기다리지 않는다(이벤트 처리기 안).
   */
  private dropTunnel(gen: number, reason: string) {
    if (gen !== this.tunnelGen) return;
    this.tunnelGen++;
    const { pool, tunnelServer, sshConn } = this;
    this.pool = null;
    this.tunnelServer = null;
    this.sshConn = null;
    this.connectPromise = null;
    if (pool || tunnelServer || sshConn) {
      console.error(`⚠️ SSH tunnel dropped (${reason}) — it will reopen on the next database call.`);
    }
    pool?.end().catch(() => {});
    tunnelServer?.close();
    try { sshConn?.end(); } catch { /* 이미 닫힘 */ }
  }

  /**
   * Use this for atomic transactions.
   * Remember to release the client!
   */
  public async getClient(): Promise<pg.PoolClient> {
    const pool = await this.connect();
    const client = await pool.connect();
    if (!this.guardedClients.has(client)) {
      this.guardedClients.add(client);
      client.on('error', (err) => console.error(`⚠️ Database client error (in use): ${err.message}`));
    }
    return client;
  }

  public async query(text: string, params?: any[]) {
    const pool = await this.connect();
    return pool.query(text, params);
  }

  public async close() {
    this.connectPromise = null;
    this.tunnelGen++; // 이 뒤의 close 이벤트가 다른 일을 하지 않게

    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.pool = null;
    }

    if (this.tunnelServer) {
      const server = this.tunnelServer;
      this.tunnelServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    if (this.sshConn) {
      try { this.sshConn.end(); } catch { /* 이미 닫힘 */ }
      this.sshConn = null;
      console.error("🔒 SSH Tunnel closed.");
    }
  }
}

/** 놀던 연결이 끊겨도(서버 재시작·SSH 끊김) 프로세스를 끄지 않는다 — pg 는 그 연결만 버린다. */
function guardPool(pool: pg.Pool) {
  pool.on('error', (err) => console.error(`⚠️ Database idle client error: ${err.message}`));
}

export const db = DatabaseManager.getInstance();

import pg from 'pg';
import { createTunnel } from 'tunnel-ssh';
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────
// Config (.env) loading
// Search order — first hit wins:
//   1. MEMORY_CONFIG_PATH (explicit override)
//   2. process.cwd()/.env  (project-local — preserves dev workflow)
//   3. ~/.config/mcp-agents-memory/.env  (XDG, where the wizard writes)
//   4. __dirname/../.env  (legacy fallback inside the package)
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
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      envLoadedFrom = candidate;
      return candidate;
    }
  }
  return null;
}

loadEnv();

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

export class DatabaseManager {
  private static instance: DatabaseManager;
  private pool: pg.Pool | null = null;
  private tunnelServer: any = null;
  private tunnelConn: any = null;
  private connectPromise: Promise<pg.Pool> | null = null;

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

        if (useSSH) {
          console.error("🔑 Establishing SSH Tunnel...");

          const tunnelOptions = { autoClose: false };
          const serverOptions = { port: 0 };
          const sshOptions = {
            host: process.env.SSH_HOST,
            port: parseInt(process.env.SSH_PORT || '22'),
            username: process.env.SSH_USER,
            privateKey: fs.readFileSync(path.resolve(process.cwd(), process.env.SSH_KEY_PATH || '')),
            passphrase: process.env.SSH_PASS
          };

          const forwardOptions = {
            srcAddr: '127.0.0.1',
            srcPort: 0,
            dstAddr: process.env.DB_HOST || 'localhost',
            dstPort: parseInt(process.env.DB_PORT || '5432')
          };

          return new Promise<pg.Pool>((resolve, reject) => {
            // @ts-ignore
            createTunnel(tunnelOptions, serverOptions, sshOptions, forwardOptions)
              .then(async ([server, conn]: any) => {
                this.tunnelServer = server;
                this.tunnelConn = conn;

                const addr = server.address();
                const localPort = (addr && typeof addr === 'object') ? addr.port : 0;

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

                try {
                  await pool.query('SELECT 1');
                  console.error("✅ Database connection verified.");
                  this.pool = pool;
                  resolve(pool);
                } catch (err) {
                  console.error("❌ Database connection probe failed:", err);
                  await pool.end().catch(() => {});
                  server.close();
                  conn.end();
                  reject(err);
                }
              })
              .catch((err: any) => {
                console.error("❌ Failed to create SSH tunnel:", err);
                reject(err);
              });
          });
        }

        const { config, description } = buildPoolConfig();
        const pool = new Pool(config);
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

  /**
   * Use this for atomic transactions.
   * Remember to release the client!
   */
  public async getClient(): Promise<pg.PoolClient> {
    const pool = await this.connect();
    return pool.connect();
  }

  public async query(text: string, params?: any[]) {
    const pool = await this.connect();
    return pool.query(text, params);
  }

  public async close() {
    this.connectPromise = null;

    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.pool = null;
    }

    if (this.tunnelConn) {
      this.tunnelConn.end();
      this.tunnelConn = null;
    }

    if (this.tunnelServer) {
      await new Promise<void>((resolve) => {
        this.tunnelServer.close(() => {
          this.tunnelServer = null;
          console.error("🔒 SSH Tunnel closed.");
          resolve();
        });
      });
    }
  }
}

export const db = DatabaseManager.getInstance();

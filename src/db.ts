import pg from 'pg';
import { createTunnel } from 'tunnel-ssh';
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';

const defaultEnvPath = path.resolve(process.cwd(), '.env');
const fallbackEnvPath = '/Users/hoon/Documents/Playgrounds/mcp-agents-memory/.env';

if (fs.existsSync(defaultEnvPath)) {
  dotenv.config({ path: defaultEnvPath });
} else {
  dotenv.config({ path: fallbackEnvPath });
}

const { Pool } = pg;

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
                  max: 10, // Cap pool size
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
        } else {
          const pool = new Pool({
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT || '5432'),
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
            max: 10,
          });

          await pool.query('SELECT 1');
          this.pool = pool;
          return pool;
        }
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

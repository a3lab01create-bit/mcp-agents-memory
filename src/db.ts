import pg from 'pg';
import { createTunnel } from 'tunnel-ssh';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export class DatabaseManager {
  private static instance: DatabaseManager;
  private pool: pg.Pool | null = null;
  private tunnelServer: any = null;

  private constructor() {}

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  public async connect(): Promise<pg.Pool> {
    if (this.pool) return this.pool;

    const useSSH = process.env.SSH_ENABLED === 'true';

    if (useSSH) {
      console.error("🔑 Establishing SSH Tunnel...");
      
      const tunnelOptions = {
        autoClose: false // GPT 제안: 안정성을 위해 터널 자동 종료 비활성화
      };

      const serverOptions = {
        port: 0 
      };

      const sshOptions = {
        host: process.env.SSH_HOST,
        port: parseInt(process.env.SSH_PORT || '22'),
        username: process.env.SSH_USER,
        privateKey: fs.readFileSync(process.env.SSH_KEY_PATH || ''),
        passphrase: process.env.SSH_PASS 
      };

      const forwardOptions = {
        srcAddr: '127.0.0.1',
        srcPort: 0, 
        dstAddr: process.env.DB_HOST || 'localhost',
        dstPort: parseInt(process.env.DB_PORT || '5432')
      };

      return new Promise((resolve, reject) => {
        // @ts-ignore
        createTunnel(tunnelOptions, serverOptions, sshOptions, forwardOptions)
          .then(async ([server, conn]: any) => {
            this.tunnelServer = server;
            
            const addr = server.address();
            const localPort = (addr && typeof addr === 'object') ? addr.port : 0;
            
            console.error(`✅ SSH Tunnel established on local port ${localPort}`);

            this.pool = new Pool({
              host: '127.0.0.1',
              port: localPort,
              user: process.env.DB_USER,
              password: process.env.DB_PASS,
              database: process.env.DB_NAME,
            });

            // 🔥 GPT 제안: 연결 즉시 검증 (Probe Query)
            try {
              await this.pool.query('SELECT 1');
              console.error("✅ Database connection verified.");
              resolve(this.pool);
            } catch (err) {
              console.error("❌ Database connection probe failed:", err);
              this.pool = null;
              server.close();
              reject(err);
            }
          })
          .catch((err: any) => {
            console.error("❌ Failed to create SSH tunnel:", err);
            reject(err);
          });
      });
    } else {
      this.pool = new Pool({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '5432'),
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
      });

      // 🔥 연결 즉시 검증
      try {
        await this.pool.query('SELECT 1');
        return this.pool;
      } catch (err) {
        console.error("❌ Database connection failed:", err);
        this.pool = null;
        throw err;
      }
    }
  }

  public async query(text: string, params?: any[]) {
    const pool = await this.connect();
    return pool.query(text, params);
  }

  public async close() {
    if (this.pool) await this.pool.end();
    if (this.tunnelServer) {
      this.tunnelServer.close();
      console.error("🔒 SSH Tunnel closed.");
    }
  }
}

export const db = DatabaseManager.getInstance();

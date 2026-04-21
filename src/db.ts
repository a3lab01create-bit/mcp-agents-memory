import pg from 'pg';
import { Client as SSHClient } from 'ssh2';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export class DatabaseManager {
  private static instance: DatabaseManager;
  private pool: pg.Pool | null = null;
  private sshClient: SSHClient | null = null;

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
      return new Promise((resolve, reject) => {
        this.sshClient = new SSHClient();
        this.sshClient
          .on('ready', () => {
            const remotePort = parseInt(process.env.DB_PORT || '5432');
            const localPort = 5433;

            this.sshClient?.forwardOut(
              '127.0.0.1',
              localPort,
              process.env.DB_HOST || 'localhost',
              remotePort,
              (err, stream) => {
                if (err) {
                  this.sshClient?.end();
                  return reject(err);
                }

                this.pool = new Pool({
                  host: '127.0.0.1',
                  port: localPort,
                  user: process.env.DB_USER,
                  password: process.env.DB_PASS,
                  database: process.env.DB_NAME,
                  // @ts-ignore
                  stream: stream,
                });
                resolve(this.pool);
              }
            );
          })
          .on('error', (err: Error) => reject(err))
          .connect({
            host: process.env.SSH_HOST,
            port: parseInt(process.env.SSH_PORT || '22'),
            username: process.env.SSH_USER,
            privateKey: fs.readFileSync(process.env.SSH_KEY_PATH || ''),
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
      return this.pool;
    }
  }

  public async query(text: string, params?: any[]) {
    const pool = await this.connect();
    return pool.query(text, params);
  }

  public async close() {
    if (this.pool) await this.pool.end();
    if (this.sshClient) this.sshClient.end();
  }
}

export const db = DatabaseManager.getInstance();

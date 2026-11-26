/**
 * check_ssh_tunnel 이 띄우는 자식 프로세스. src/db.ts 의 DatabaseManager 를 그대로 쓴다.
 * MEMORY_CONFIG_PATH 로 시험용 SSH·DB 설정을 받는다(import 전에 env 가 있어야 한다).
 *
 * stdin 한 줄 = 명령, stdout 한 줄 = 결과:
 *   query   → "ok <n>" | "err <메시지>"
 *   hold    → getClient() 로 연결 하나를 빌려 둔다 → "held" | "err …"
 *   release → 빌린 연결을 돌려준다 → "released"
 *   close   → db.close() 후 종료 → "closed"
 * 프로세스가 죽으면 부모가 exit code 와 stderr 로 본다.
 */
import readline from "node:readline";
import { db } from "../src/db.js";

let held: any = null;
const rl = readline.createInterface({ input: process.stdin });
const out = (s: string) => process.stdout.write(s + "\n");
out("ready");

rl.on("line", async (line) => {
  const cmd = line.trim();
  try {
    if (cmd === "query") {
      const r = await db.query("SELECT 1 AS ok");
      out(`ok ${r.rows[0].ok}`);
    } else if (cmd === "hold") {
      held = await db.getClient();
      out("held");
    } else if (cmd === "release") {
      try { held?.release(true); } catch { /* 이미 끊긴 연결 */ }
      held = null;
      out("released");
    } else if (cmd === "close") {
      await db.close();
      out("closed");
      process.exit(0);
    }
  } catch (err: any) {
    out(`err ${String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 200)}`);
  }
});

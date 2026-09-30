import { db } from "../db.js";

const MIGRATION_NAME = "029_venue";

/**
 * memory.venue — 이 대화가 "어디서(누가 보는 자리에서)" 오갔는지.
 *
 * agent_platform은 어떤 프로그램이 돌렸는지(claude-code, hermes …)이고, venue는
 * 대화가 보인 자리다. 같은 기계·같은 시간에 버즈 단체방과 터미널 1:1이 동시에
 * 돌면 created_at/device로는 가를 수 없어서 따로 둔다.
 *
 *   terminal          사람과 1:1 (Claude Code 대화형, Hermes cli)
 *   buzz:<채널이름>   버즈 채널 (예: buzz:DevRoom)
 *   buzz:dm           버즈 DM
 *   buzz              버즈인 건 확실하지만 채널을 못 읽음
 *   slack             슬랙 (채널은 일부러 안 적음 — 버즈로 대체 예정)
 *   auto              자동 실행 (print 모드 등, 슬랙 표식 없음)
 *   subagent          하위 에이전트 세션
 *   NULL              모름 (옛 행, 정보 없는 플랫폼)
 *
 * 채널 이름이 나중에 바뀌면 같은 방이 두 이름으로 갈릴 수 있다. 정리된 버즈 행의
 * <context>에 `Channel: 이름 (#uuid)`가 그대로 남아 있어 언제든 다시 매길 수 있으므로
 * uuid를 따로 저장하지 않는다.
 *
 * nullable·기본값 없음 → 기존 행 재작성 없음. lock_timeout 5s + 재시도는 028과 같다.
 */
const LOCK_RETRIES = 24;
const LOCK_RETRY_WAIT_MS = 5000;

async function migrate() {
  console.log(`💾 Running Migration: ${MIGRATION_NAME}...`);

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS migration_history (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const check = await db.query(
      "SELECT 1 FROM migration_history WHERE name = $1",
      [MIGRATION_NAME]
    );
    if (check.rows.length > 0) {
      console.log(`⏩ Migration ${MIGRATION_NAME} already applied. Skipping.`);
      return;
    }

    for (let attempt = 1; ; attempt++) {
      const client = await db.getClient();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '5s'");

        await client.query(`
          ALTER TABLE memory
            ADD COLUMN IF NOT EXISTS venue TEXT;
        `);

        await client.query("INSERT INTO migration_history (name) VALUES ($1)", [
          MIGRATION_NAME,
        ]);
        await client.query("COMMIT");
        console.log(`✅ Migration ${MIGRATION_NAME} completed successfully!`);
        break;
      } catch (txErr) {
        await client.query("ROLLBACK");
        // 55P03 lock_not_available — Cold Path 배치 등이 memory를 잡고 있음
        if ((txErr as { code?: string }).code !== "55P03" || attempt >= LOCK_RETRIES) throw txErr;
        console.log(
          `⏳ memory 테이블 잠금 대기 중 (${attempt}/${LOCK_RETRIES}) — ${LOCK_RETRY_WAIT_MS / 1000}초 뒤 재시도`
        );
        await new Promise((r) => setTimeout(r, LOCK_RETRY_WAIT_MS));
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error(`❌ Migration ${MIGRATION_NAME} FAILED:`, err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

migrate();

import { db } from "../db.js";

const MIGRATION_NAME = "028_raw_message";

/**
 * memory.raw_message — 정리 전 원문 보관 칸.
 *
 * 배경: Buzz ACP 봉투(매 턴 반복되는 플랫폼 설명서·에이전트 설정·이전 대화
 * 재인용)가 user 메시지째 캡처되면 태거는 ctx 초과로 fallback하고, 임베딩
 * (앞 8,000자)은 설명서로만 계산된다. Hot Path가 봉투를 걷어낸 본문을
 * message에 넣고, 원문은 여기에 그대로 남긴다 (원본 보존).
 *
 *   raw_message IS NULL      → message가 곧 원문 (기존 모든 행, 일반 캡처)
 *   raw_message IS NOT NULL  → raw_message가 캡처 원문, message는 그 정리본
 *                              (이후 manage_knowledge update로 message만 고쳐졌을 수 있음)
 *   agent_platform = 'buzz'  → (0.9.20 buzz-ingest) raw_message는 버즈 본문, message는
 *                              `[작성자] 본문` — 봉투 정리본이 아니므로 재정리 스크립트에서 제외할 것
 *
 * nullable·기본값 없음이라 기존 행 재작성이 없다 (메타데이터만 변경).
 *
 * ADD COLUMN은 ACCESS EXCLUSIVE 잠금이 필요하다. Cold Path 워커가 배치를
 * 트랜잭션으로 잡고 있으면 그걸 기다리는 동안 모든 캡처 INSERT가 뒤에 줄을
 * 선다 → lock_timeout 5초로 짧게 시도하고, 못 잡으면 물러났다가 재시도.
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
            ADD COLUMN IF NOT EXISTS raw_message TEXT;
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

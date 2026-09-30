/**
 * memory 테이블의 선택 칸(마이그레이션으로 추가된 칸)이 이 DB에 있는지.
 * 마이그레이션 전 DB에서도 조회·브리핑이 멈추지 않게, 없으면 그 칸을 빼고 동작한다.
 * 있으면 영구 캐시, 없으면 5분마다 다시 확인.
 */
import { db } from "./db.js";

const cache = new Map<string, { exists: boolean; checkedAt: number }>();

export async function hasMemoryColumn(column: string): Promise<boolean> {
  const c = cache.get(column);
  if (c && (c.exists || Date.now() - c.checkedAt < 5 * 60 * 1000)) return c.exists;
  let exists = false;
  try {
    const r = await db.query(
      // 쿼리가 search_path로 찾는 바로 그 memory 테이블 기준
      `SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('memory') AND attname = $1 AND NOT attisdropped LIMIT 1`,
      [column]
    );
    exists = r.rows.length > 0;
  } catch {
    exists = false; // 확인 실패 = 없는 것으로 보고 그 칸 없이 동작 (5분 뒤 다시 확인)
  }
  cache.set(column, { exists, checkedAt: Date.now() });
  return exists;
}

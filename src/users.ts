/**
 * users 테이블 관리 helper.
 *
 * 단일 user 가정 (form 본인). multi-user 확장 가능 (user_name UNIQUE).
 * 자동 생성 — `getOrCreateUser('hoon')` 호출 시 없으면 INSERT.
 */

import { db } from "./db.js";

const cache = new Map<string, number>();

export async function getOrCreateUser(userName: string): Promise<number> {
  const cached = cache.get(userName);
  if (cached !== undefined) return cached;

  // 1차: 이미 있나 확인
  const existing = await db.query(
    `SELECT user_id FROM users WHERE user_name = $1 LIMIT 1`,
    [userName]
  );
  if (existing.rows.length > 0) {
    const id = Number(existing.rows[0].user_id);
    cache.set(userName, id);
    return id;
  }

  // 2차: INSERT (race condition 안전: ON CONFLICT)
  const inserted = await db.query(
    `INSERT INTO users (user_name) VALUES ($1)
       ON CONFLICT (user_name) DO UPDATE SET updated_at = users.updated_at
       RETURNING user_id`,
    [userName]
  );
  const id = Number(inserted.rows[0].user_id);
  cache.set(userName, id);
  return id;
}

/**
 * 환경변수 또는 default로 form 본인 user_id 반환. 단일 user 가정.
 *   USER_NAME env (default 'hoon').
 */
export async function getDefaultUserId(): Promise<number> {
  const name = process.env.USER_NAME ?? 'hoon';
  return getOrCreateUser(name);
}

/** 핵심/부가 프로필 갱신 (manage_knowledge target='sub_profile'에서 호출). */
export async function updateUserProfile(
  userId: number,
  field: 'core_profile' | 'sub_profile',
  value: string | null
): Promise<void> {
  if (field === 'core_profile') {
    await db.query(
      `UPDATE users SET core_profile = $1 WHERE user_id = $2`,
      [value, userId]
    );
  } else {
    await db.query(
      `UPDATE users SET sub_profile = $1 WHERE user_id = $2`,
      [value, userId]
    );
  }
}

/** 현재 sub_profile 가져오기 (append 시 사용). */
export async function getUserProfile(
  userId: number
): Promise<{ core_profile: string | null; sub_profile: string | null }> {
  const r = await db.query(
    `SELECT core_profile, sub_profile FROM users WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] ?? { core_profile: null, sub_profile: null };
}

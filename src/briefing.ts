/**
 * Briefing — 시작 시 자동 주입용 brief 생성.
 *
 * RESPEC PROBLEMS.md §1 fix. 두 path:
 *   1. server connect 시 instructions 필드에 동적 주입 (primary)
 *   2. memory_startup MCP tool로 mid-session refresh (optional fallback)
 *
 * Brief 내용 (size budget ~2-3KB; client context 한계 고려):
 *   - users.core_profile + sub_profile (form 정체성)
 *   - 최근 활성 p_tag top 5 (count + 마지막 사용)
 *   - 최근 N개 메시지 요약 (raw 전체 X — 시간순 짧게)
 */

import { db } from "./db.js";
import { getDefaultUserId } from "./users.js";

const RECENT_MESSAGE_LIMIT = 8;        // 최근 N건만 요약 (size budget)
const RECENT_MESSAGE_PREVIEW = 100;     // 각 메시지 첫 N자만
const ACTIVE_PTAG_LIMIT = 5;            // 활성 프로젝트 태그 top N

export interface BriefData {
  user_name: string;
  core_profile: string | null;
  sub_profile: string | null;
  active_p_tags: Array<{ name: string; count: number; last_used: Date | null }>;
  recent_messages: Array<{ role: string; preview: string; created_at: Date }>;
  short_term_window_days: number;
}

/** brief 데이터 수집. Hot Path INSERT가 빈번할 때도 빠르게 (~50ms) 동작 목표. */
export async function collectBrief(opts: { userId?: number; shortTermDays?: number } = {}): Promise<BriefData> {
  const userId = opts.userId ?? (await getDefaultUserId());
  const shortTermDays = opts.shortTermDays ?? Number(process.env.SHORT_TERM_DAYS ?? 3);

  // user 정보
  const u = await db.query(
    `SELECT user_name, core_profile, sub_profile FROM users WHERE user_id = $1`,
    [userId]
  );
  const user = u.rows[0] ?? { user_name: 'unknown', core_profile: null, sub_profile: null };

  // 최근 활성 p_tags top N
  const ptags = await db.query(
    `SELECT pt.name,
            COUNT(*)::int AS cnt,
            MAX(m.created_at) AS last_used
       FROM memory m
       JOIN project_tags pt ON pt.id = m.p_tag_id
      WHERE m.user_id = $1
        AND m.is_active = TRUE
        AND m.created_at >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY pt.name
      ORDER BY MAX(m.created_at) DESC
      LIMIT $3`,
    [userId, String(shortTermDays), ACTIVE_PTAG_LIMIT]
  );

  // 최근 메시지 요약 (raw 첫 N자만)
  const msgs = await db.query(
    `SELECT role, message, created_at
       FROM memory
      WHERE user_id = $1
        AND is_active = TRUE
        AND created_at >= NOW() - ($2 || ' days')::INTERVAL
      ORDER BY created_at DESC
      LIMIT $3`,
    [userId, String(shortTermDays), RECENT_MESSAGE_LIMIT]
  );

  return {
    user_name: user.user_name,
    core_profile: user.core_profile,
    sub_profile: user.sub_profile,
    active_p_tags: ptags.rows.map((r: any) => ({
      name: r.name,
      count: r.cnt,
      last_used: r.last_used,
    })),
    recent_messages: msgs.rows.reverse().map((r: any) => ({  // 시간순 (오래된 → 최근)
      role: r.role,
      preview: String(r.message ?? '').slice(0, RECENT_MESSAGE_PREVIEW),
      created_at: r.created_at,
    })),
    short_term_window_days: shortTermDays,
  };
}

/** brief 데이터 → markdown 문자열. instructions 필드 또는 tool 응답에 사용. */
export function formatBriefMarkdown(brief: BriefData): string {
  const lines: string[] = [];
  lines.push(`# Memory Briefing (user: ${brief.user_name})`);
  lines.push("");

  if (brief.core_profile) {
    lines.push(`## Core Profile`);
    lines.push(brief.core_profile);
    lines.push("");
  }

  if (brief.sub_profile) {
    lines.push(`## Sub Profile`);
    lines.push(brief.sub_profile);
    lines.push("");
  }

  if (brief.active_p_tags.length > 0) {
    lines.push(`## Active Projects (last ${brief.short_term_window_days} days)`);
    for (const t of brief.active_p_tags) {
      const dt = t.last_used ? t.last_used.toISOString().slice(0, 10) : '?';
      lines.push(`- **${t.name}** — ${t.count} memories (last: ${dt})`);
    }
    lines.push("");
  }

  if (brief.recent_messages.length > 0) {
    lines.push(`## Recent Memory (last ${brief.recent_messages.length}, oldest → newest)`);
    for (const m of brief.recent_messages) {
      const dt = m.created_at?.toISOString?.().slice(11, 16) ?? '';
      lines.push(`- [${dt} ${m.role}] ${m.preview}${m.preview.length >= RECENT_MESSAGE_PREVIEW ? '…' : ''}`);
    }
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`Use \`search_memory({ query, p_tag, date_range, role, include_archived })\` to retrieve more.`);
  lines.push(`Use \`memory_startup\` tool for a refreshed brief mid-session.`);

  return lines.join("\n");
}

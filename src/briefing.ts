/**
 * Briefing — 시작 시 자동 주입용 brief 생성.
 *
 * RESPEC PROBLEMS.md §1 fix. 두 path:
 *   1. server connect 시 instructions 필드에 동적 주입 (primary)
 *   2. memory_startup MCP tool로 mid-session refresh (optional fallback)
 *
 * 4-30 form catch — platform priority:
 *   currentPlatform이 주어지면 brief가 그 platform 메시지를 우선 보여주고
 *   다른 platform 메시지는 별도 섹션으로 짧게 요약. unified vision은 유지하되
 *   "지금 어디서 일하고 있는지"가 brief의 default lens.
 *
 * Brief 내용 (size budget ~2-3KB):
 *   - users.core_profile + sub_profile (form 정체성)
 *   - 활성 p_tag top 5 (currentPlatform 있으면 그 platform 우선)
 *   - 최근 메시지 — currentPlatform 있으면 8건 from current + 4건 from others
 *     (없으면 8건 cross-platform)
 */

import { db } from "./db.js";
import { getDefaultUserId } from "./users.js";

const RECENT_CURRENT_LIMIT = 8;        // 현 platform 최근 N건 (또는 cross-platform 8건)
const RECENT_OTHERS_LIMIT = 4;          // 타 platform 최근 N건 (currentPlatform 있을 때만)
const RECENT_MESSAGE_PREVIEW = 100;     // 각 메시지 첫 N자만
const ACTIVE_PTAG_LIMIT = 5;            // 활성 프로젝트 태그 top N

export interface BriefMessage {
  role: string;
  agent_platform: string;
  preview: string;
  created_at: Date;
}

export interface BriefData {
  user_name: string;
  core_profile: string | null;
  sub_profile: string | null;
  active_p_tags: Array<{ name: string; count: number; last_used: Date | null }>;
  /** currentPlatform 메시지 (또는 currentPlatform 없을 땐 cross-platform 통합). */
  recent_messages_current: BriefMessage[];
  /** 타 platform 메시지 (currentPlatform 있을 때만 채워짐, 없으면 빈 배열). */
  recent_messages_others: BriefMessage[];
  /** brief 만들 때 우선 lens. null이면 cross-platform 통합 brief. */
  current_platform: string | null;
  short_term_window_days: number;
}

export interface CollectBriefOpts {
  userId?: number;
  shortTermDays?: number;
  /** "claude-code" / "gemini-cli-mcp-client" 등. null/undefined면 cross-platform brief. */
  currentPlatform?: string | null;
}

/** brief 데이터 수집. Hot Path INSERT가 빈번할 때도 빠르게 (~50ms) 동작 목표. */
export async function collectBrief(opts: CollectBriefOpts = {}): Promise<BriefData> {
  const userId = opts.userId ?? (await getDefaultUserId());
  const shortTermDays = opts.shortTermDays ?? Number(process.env.SHORT_TERM_DAYS ?? 3);
  const currentPlatform = opts.currentPlatform ?? null;

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

  // 최근 메시지 — currentPlatform 분기
  let recentCurrent: BriefMessage[] = [];
  let recentOthers: BriefMessage[] = [];

  if (currentPlatform) {
    // current platform 메시지 우선
    const currentMsgs = await db.query(
      `SELECT role, agent_platform, message, created_at
         FROM memory
        WHERE user_id = $1
          AND is_active = TRUE
          AND created_at >= NOW() - ($2 || ' days')::INTERVAL
          AND agent_platform = $3
        ORDER BY created_at DESC
        LIMIT $4`,
      [userId, String(shortTermDays), currentPlatform, RECENT_CURRENT_LIMIT]
    );
    recentCurrent = currentMsgs.rows.reverse().map(rowToMsg);

    // other platforms 메시지 (preview)
    const othersMsgs = await db.query(
      `SELECT role, agent_platform, message, created_at
         FROM memory
        WHERE user_id = $1
          AND is_active = TRUE
          AND created_at >= NOW() - ($2 || ' days')::INTERVAL
          AND agent_platform != $3
        ORDER BY created_at DESC
        LIMIT $4`,
      [userId, String(shortTermDays), currentPlatform, RECENT_OTHERS_LIMIT]
    );
    recentOthers = othersMsgs.rows.reverse().map(rowToMsg);
  } else {
    // cross-platform 통합 brief (legacy 동작)
    const msgs = await db.query(
      `SELECT role, agent_platform, message, created_at
         FROM memory
        WHERE user_id = $1
          AND is_active = TRUE
          AND created_at >= NOW() - ($2 || ' days')::INTERVAL
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, String(shortTermDays), RECENT_CURRENT_LIMIT]
    );
    recentCurrent = msgs.rows.reverse().map(rowToMsg);
  }

  return {
    user_name: user.user_name,
    core_profile: user.core_profile,
    sub_profile: user.sub_profile,
    active_p_tags: ptags.rows.map((r: any) => ({
      name: r.name,
      count: r.cnt,
      last_used: r.last_used,
    })),
    recent_messages_current: recentCurrent,
    recent_messages_others: recentOthers,
    current_platform: currentPlatform,
    short_term_window_days: shortTermDays,
  };
}

function rowToMsg(r: any): BriefMessage {
  return {
    role: r.role,
    agent_platform: r.agent_platform,
    preview: String(r.message ?? '').slice(0, RECENT_MESSAGE_PREVIEW),
    created_at: r.created_at,
  };
}

/** brief 데이터 → markdown 문자열. instructions 필드 또는 tool 응답에 사용. */
export function formatBriefMarkdown(brief: BriefData): string {
  const lines: string[] = [];
  lines.push(`# Memory Briefing (user: ${brief.user_name})`);
  if (brief.current_platform) {
    lines.push(`Current platform: \`${brief.current_platform}\``);
  }
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

  if (brief.recent_messages_current.length > 0) {
    const heading = brief.current_platform
      ? `## Recent on ${brief.current_platform} (last ${brief.recent_messages_current.length}, oldest → newest)`
      : `## Recent Memory (last ${brief.recent_messages_current.length}, oldest → newest)`;
    lines.push(heading);
    for (const m of brief.recent_messages_current) {
      lines.push(formatMsgLine(m, brief.current_platform === null));
    }
    lines.push("");
  }

  if (brief.recent_messages_others.length > 0) {
    lines.push(`## Cross-platform Whispers (other agents, last ${brief.recent_messages_others.length})`);
    for (const m of brief.recent_messages_others) {
      lines.push(formatMsgLine(m, true)); // 항상 platform 표시
    }
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`Use \`search_memory({ query, p_tag, date_range, role, agent_platform, include_archived })\` to retrieve more.`);
  if (brief.current_platform) {
    lines.push(`Cross-platform search: \`search_memory({ query, agent_platform: "*" })\`.`);
  }
  lines.push(`Use \`memory_startup\` tool for a refreshed brief mid-session.`);

  return lines.join("\n");
}

function formatMsgLine(m: BriefMessage, showPlatform: boolean): string {
  const dt = m.created_at?.toISOString?.().slice(11, 16) ?? '';
  const platformTag = showPlatform ? `${m.agent_platform} ` : '';
  const truncated = m.preview.length >= RECENT_MESSAGE_PREVIEW ? '…' : '';
  return `- [${dt} ${platformTag}${m.role}] ${m.preview}${truncated}`;
}

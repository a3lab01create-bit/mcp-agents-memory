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

import * as os from "node:os";
import { db } from "./db.js";
import { getDefaultUserId } from "./users.js";

const RECENT_CURRENT_LIMIT = 8;        // 현 platform+기기 최근 N건. ⚠️ N × PREVIEW_RECENT(300) ≈ 2.4KB —
                                       //   memory_startup은 캡 없는 툴 응답이라 OK. 단 mid-session 반복 호출 시 매번 재주입됨.
const RECENT_OTHERS_LIMIT = 4;          // 타 platform 최근 N건 (currentPlatform 있을 때만)
// 미리보기 길이 — 캡과 디커플. rowToMsg는 MAX_PREVIEW_STORE까지 저장하고,
// formatMsgLine이 context별 maxPreview로 슬라이스한다.
// invariant: MAX_PREVIEW_STORE > 모든 maxPreview 값 (안 그러면 '…' 잘림 표시가 깨짐).
const MAX_PREVIEW_STORE = 500;          // rowToMsg 저장 상한
const PREVIEW_COMPACT = 100;            // pinned·whispers·inject (캡 민감 → 짧게)
const PREVIEW_RECENT = 300;             // full-mode 현재기기 Recent (캡 없는 툴 응답 → 두껍게)
const ACTIVE_PTAG_LIMIT = 5;            // 활성 프로젝트 태그 top N
const PENDING_ALIAS_SUGGESTION_LIMIT = 2; // brief에 노출할 대기 별칭 제안 top N (Stage 2 confirm 게이트)
const PINNED_LIMIT = 10;                // 고정 메모리 top N (full brief)
const INJECT_PINNED_LIMIT = 5;          // inject 모드 인라인 고정 메모리 최신 N개
// full brief(memory_startup tool) 최대 길이. 클라가 안 자르는 툴 응답이므로 넉넉히 —
// 두꺼운 Recent(현재기기 8건×300자)가 optional-fill에서 통째 드롭되지 않도록 충분해야 한다.
// inject 모드는 이 값 대신 index.ts가 INSTRUCTIONS_MAX_CHARS에서 역산한 예산(maxChars)을 받아 쓴다.
const BRIEF_MAX_CHARS = Number(process.env.BRIEF_MAX_CHARS ?? 8000);

export interface BriefMessage {
  role: string;
  agent_platform: string;
  device_name: string | null;
  preview: string;
  created_at: Date;
}

export interface BriefData {
  user_name: string;
  core_profile: string | null;
  sub_profile: string | null;
  active_p_tags: Array<{ name: string; count: number; last_used: Date | null }>;
  /** 중요 고정 메모리 (최신순) */
  pinned_memories: BriefMessage[];
  /** 사용자 확인 대기 별칭 제안 (Stage 2 confirm 게이트, 최신 top N) */
  pending_alias_suggestions: Array<{ id: number; source: string; target: string; relation: string; confidence: number }>;
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
  /** 현재 기기명 (default os.hostname()). currentPlatform 분기의 recent를 이 기기로 스코프. */
  deviceName?: string;
}

/** brief 데이터 수집. Hot Path INSERT가 빈번할 때도 빠르게 (~50ms) 동작 목표. */
export async function collectBrief(opts: CollectBriefOpts = {}): Promise<BriefData> {
  const userId = opts.userId ?? (await getDefaultUserId());
  const shortTermDays = opts.shortTermDays ?? Number(process.env.SHORT_TERM_DAYS ?? 3);
  const currentPlatform = opts.currentPlatform ?? null;
  const deviceName = opts.deviceName ?? os.hostname();

  // user 정보
  const u = await db.query(
    `SELECT user_name, core_profile, sub_profile FROM users WHERE user_id = $1`,
    [userId]
  );
  const user = u.rows[0] ?? { user_name: 'unknown', core_profile: null, sub_profile: null };

  // 중요 고정 메모리 (Pinned)
  const pinnedMsgs = await db.query(
    `SELECT role, agent_platform, device_name, message, created_at
       FROM memory
      WHERE user_id = $1
        AND is_active = TRUE
        AND is_pinned = TRUE
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, PINNED_LIMIT]
  );

  // 최근 활성 p_tags top N
  const ptags = await db.query(
    `SELECT cpt.name,
            COUNT(*)::int AS cnt,
            MAX(m.created_at) AS last_used
       FROM memory m
       JOIN project_tags cpt ON cpt.id = canonical_project_tag_id(m.p_tag_id)
      WHERE m.user_id = $1
        AND m.is_active = TRUE
        AND m.created_at >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY cpt.name
      ORDER BY MAX(m.created_at) DESC
      LIMIT $3`,
    [userId, String(shortTermDays), ACTIVE_PTAG_LIMIT]
  );

  // 최근 메시지 — currentPlatform 분기
  let recentCurrent: BriefMessage[] = [];
  let recentOthers: BriefMessage[] = [];

  if (currentPlatform) {
    // current platform + 현재 기기 메시지 우선 (연속성: "이 기기에서 뭐 하다 끊겼나")
    const currentMsgs = await db.query(
      `SELECT role, agent_platform, device_name, message, created_at
         FROM memory
        WHERE user_id = $1
          AND is_active = TRUE
          AND created_at >= NOW() - ($2 || ' days')::INTERVAL
          AND agent_platform = $3
          AND device_name = $4
          AND is_pinned = FALSE
        ORDER BY created_at DESC
        LIMIT $5`,
      [userId, String(shortTermDays), currentPlatform, deviceName, RECENT_CURRENT_LIMIT]
    );
    recentCurrent = currentMsgs.rows.reverse().map(rowToMsg);

    // other platforms 메시지 (preview)
    const othersMsgs = await db.query(
      `SELECT role, agent_platform, device_name, message, created_at
         FROM memory
        WHERE user_id = $1
          AND is_active = TRUE
          AND created_at >= NOW() - ($2 || ' days')::INTERVAL
          AND agent_platform != $3
          AND is_pinned = FALSE
        ORDER BY created_at DESC
        LIMIT $4`,
      [userId, String(shortTermDays), currentPlatform, RECENT_OTHERS_LIMIT]
    );
    recentOthers = othersMsgs.rows.reverse().map(rowToMsg);
  } else {
    // cross-platform 통합 brief (legacy 동작)
    const msgs = await db.query(
      `SELECT role, agent_platform, device_name, message, created_at
         FROM memory
        WHERE user_id = $1
          AND is_active = TRUE
          AND created_at >= NOW() - ($2 || ' days')::INTERVAL
          AND is_pinned = FALSE
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, String(shortTermDays), RECENT_CURRENT_LIMIT]
    );
    recentCurrent = msgs.rows.reverse().map(rowToMsg);
  }

  // 사용자 확인 대기 별칭 제안 (Stage 2 confirm 게이트)
  const aliasSugg = await db.query(
    `SELECT s.id, src.name AS source, tgt.name AS target, s.relation, s.confidence
       FROM project_tag_alias_suggestions s
       JOIN project_tags src ON src.id = s.source_tag_id
       JOIN project_tags tgt ON tgt.id = s.target_tag_id
      WHERE s.user_id = $1 AND s.status = 'pending'
      ORDER BY s.confidence DESC, s.created_at DESC
      LIMIT $2`,
    [userId, PENDING_ALIAS_SUGGESTION_LIMIT]
  );

  return {
    user_name: user.user_name,
    core_profile: user.core_profile,
    sub_profile: user.sub_profile,
    pinned_memories: pinnedMsgs.rows.map(rowToMsg),
    pending_alias_suggestions: aliasSugg.rows.map((r: any) => ({
      id: Number(r.id),
      source: String(r.source),
      target: String(r.target),
      relation: String(r.relation),
      confidence: Number(r.confidence),
    })),
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
    device_name: r.device_name ?? null,
    preview: String(r.message ?? '').slice(0, MAX_PREVIEW_STORE),
    created_at: r.created_at,
  };
}

/**
 * brief 데이터 → markdown 문자열. instructions 필드 또는 tool 응답에 사용.
 *
 * 2-pass budget model:
 *   1. Guaranteed sections (header + profiles + pinned) — 항상 포함, budget 초과해도 유지.
 *   2. Optional sections (active projects + recent messages) — 남은 budget 내 섹션 단위로 채움.
 * 결과는 BRIEF_MAX_CHARS 이하. is_pinned 항목은 절대 잘리지 않음.
 */
export interface FormatBriefOpts {
  /** 'inject' = 시작 instructions용 압축 brief (Sub Profile·Recent 드롭, 예산 내 Pinned+Active만).
   *  'full' = memory_startup tool용 전체 brief. default 'full'. */
  mode?: "inject" | "full";
  /** inject 모드에서 brief가 차지할 수 있는 최대 char 수 (초과 줄은 graceful drop). */
  maxChars?: number;
}

export function formatBriefMarkdown(brief: BriefData, opts: FormatBriefOpts = {}): string {
  if ((opts.mode ?? "full") === "inject") {
    return formatBriefInject(brief, opts.maxChars ?? BRIEF_MAX_CHARS);
  }
  return formatBriefFull(brief);
}

/** 전체 brief (memory_startup tool용). 기존 동작 유지. */
function formatBriefFull(brief: BriefData): string {
  // --- 1. Guaranteed sections ---
  const gLines: string[] = [];
  gLines.push(`# Memory Briefing (user: ${brief.user_name})`);
  if (brief.current_platform) {
    gLines.push(`Current platform: \`${brief.current_platform} @ ${os.hostname()}\``);
  }
  gLines.push('');

  if (brief.core_profile) {
    gLines.push('## Core Profile');
    gLines.push(brief.core_profile);
    gLines.push('');
  }
  if (brief.sub_profile) {
    gLines.push('## Sub Profile');
    gLines.push(brief.sub_profile);
    gLines.push('');
  }
  if (brief.pinned_memories.length > 0) {
    gLines.push('## Pinned Memories (Important Facts)');
    for (const m of brief.pinned_memories) {
      gLines.push(formatMsgLine(m, true));
    }
    gLines.push('');
  }
  if (brief.pending_alias_suggestions.length > 0) {
    gLines.push('## Project Tag Suggestions (사용자 확인 필요)');
    for (const s of brief.pending_alias_suggestions) {
      gLines.push(`- [${s.id}] \`${s.source}\` → \`${s.target}\` 같은 프로젝트로 보임 (${s.relation}, conf ${s.confidence}). 맞으면 \`manage_project_tags({action:"confirm_alias",suggestion_id:${s.id}})\`, 아니면 \`reject_alias\`.`);
    }
    gLines.push('');
  }

  const guaranteed = gLines.join('\n');

  // --- Footer (always included, counts toward budget) ---
  const footerLines = [
    '---',
    `Use \`search_memory({ query, p_tag, date_range, role, agent_platform, include_archived })\` to retrieve more.`,
    ...(brief.current_platform ? [`Cross-platform search: \`search_memory({ query, agent_platform: "*" })\`.`] : []),
    `Use \`memory_startup\` tool for a refreshed brief mid-session.`,
  ];
  const footer = footerLines.join('\n');

  // --- 2. Optional sections (fill remaining budget, whole sections only) ---
  const remaining = Math.max(0, BRIEF_MAX_CHARS - guaranteed.length - footer.length - 2);

  const optionalSections: string[] = [];

  if (brief.active_p_tags.length > 0) {
    const lines: string[] = [`## Active Projects (last ${brief.short_term_window_days} days)`];
    for (const t of brief.active_p_tags) {
      const dt = t.last_used ? t.last_used.toISOString().slice(0, 10) : '?';
      lines.push(`- **${t.name}** — ${t.count} memories (last: ${dt})`);
    }
    lines.push('');
    optionalSections.push(lines.join('\n'));
  }

  if (brief.recent_messages_current.length > 0) {
    const heading = brief.current_platform
      ? `## Recent on ${brief.current_platform} (last ${brief.recent_messages_current.length}, oldest → newest)`
      : `## Recent Memory (last ${brief.recent_messages_current.length}, oldest → newest)`;
    const lines: string[] = [heading];
    for (const m of brief.recent_messages_current) {
      lines.push(formatMsgLine(m, brief.current_platform === null, PREVIEW_RECENT));
    }
    lines.push('');
    optionalSections.push(lines.join('\n'));
  }

  if (brief.recent_messages_others.length > 0) {
    const lines: string[] = [`## Cross-platform Whispers (other agents, last ${brief.recent_messages_others.length})`];
    for (const m of brief.recent_messages_others) {
      lines.push(formatMsgLine(m, true));
    }
    lines.push('');
    optionalSections.push(lines.join('\n'));
  }

  let optionalText = '';
  for (const section of optionalSections) {
    if (optionalText.length + section.length > remaining) break;
    optionalText += section;
  }

  return guaranteed + '\n' + optionalText + '\n' + footer;
}

/**
 * inject 모드 — 시작 instructions 캡(클라이언트 ~2KB) 안에서 살아남는 압축 brief.
 *
 * 보장: header + Core Profile + pointer footer.
 * 예산 내에서 Pinned → Active Projects 순으로 줄 단위 graceful fill.
 * Sub Profile·Recent 메시지는 드롭 (memory_startup으로 lazy load).
 * Pinned이 절삭 1순위 피해자였던 full 구조(Core→Sub→Pinned)를 뒤집어 Core 바로 뒤로 끌어올림.
 */
function formatBriefInject(brief: BriefData, maxChars: number): string {
  // --- 보장 섹션: header + Core Profile ---
  const headLines: string[] = [`# Memory Briefing (user: ${brief.user_name})`];
  if (brief.current_platform) {
    headLines.push(`Current platform: \`${brief.current_platform} @ ${os.hostname()}\``);
  }
  headLines.push('');
  if (brief.core_profile) {
    headLines.push('## Core Profile', brief.core_profile, '');
  }
  const header = headLines.join('\n');

  // --- pointer footer: 나머지는 memory_startup으로 lazy load ---
  const pointer = [
    '---',
    '⚡ 압축본입니다. **세션 시작 시 `memory_startup`을 한 번 호출**해 최근 대화·활성 프로젝트·상세 프로필을 이어받으세요.',
    'Use `search_memory({ query, p_tag, date_range, role, agent_platform })` to retrieve more.',
  ].join('\n');

  // --- 남은 예산으로 Pinned → Active 순 줄 단위 fill ---
  const budget = { remaining: Math.max(0, maxChars - header.length - pointer.length - 2) };

  const pinnedLines = brief.pinned_memories
    .slice(0, INJECT_PINNED_LIMIT)
    .map((m) => formatMsgLine(m, true));
  const pinnedSection = fitSection('## Pinned Memories (Important Facts)', pinnedLines, budget);

  const activeLines = brief.active_p_tags.map((t) => {
    const dt = t.last_used ? t.last_used.toISOString().slice(0, 10) : '?';
    return `- **${t.name}** — ${t.count} memories (last: ${dt})`;
  });
  const activeSection = fitSection(
    `## Active Projects (last ${brief.short_term_window_days} days)`,
    activeLines,
    budget
  );

  return [header.trimEnd(), pinnedSection, activeSection, pointer]
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/**
 * heading + budget 내에 들어가는 만큼의 줄을 채워 반환. 한 줄도 못 넣으면 '' (heading도 생략).
 * 사용한 char 수만큼 budget.remaining 차감 (mutate).
 */
function fitSection(heading: string, lines: string[], budget: { remaining: number }): string {
  if (lines.length === 0) return '';
  const headingCost = heading.length + 1;       // heading + 후행 '\n'
  if (budget.remaining < headingCost + lines[0].length + 1) return '';
  const out: string[] = [heading];
  let used = headingCost;
  for (const ln of lines) {
    if (used + ln.length + 1 > budget.remaining) break;
    out.push(ln);
    used += ln.length + 1;
  }
  budget.remaining -= used;
  return out.join('\n');
}

function formatMsgLine(m: BriefMessage, showPlatform: boolean, maxPreview: number = PREVIEW_COMPACT): string {
  const dt = m.created_at?.toISOString?.().slice(11, 16) ?? '';
  const device = m.device_name ? `@${m.device_name} ` : '';
  const platformTag = showPlatform ? `${m.agent_platform} ${device}` : device;
  // m.preview는 MAX_PREVIEW_STORE까지 저장돼 있음 → context별 maxPreview로 슬라이스.
  // invariant(MAX_PREVIEW_STORE > maxPreview) 덕에 length > maxPreview면 '실제로 더 길다'가 보장됨.
  const truncated = m.preview.length > maxPreview;
  const text = truncated ? m.preview.slice(0, maxPreview) : m.preview;
  return `- [${dt} ${platformTag}${m.role}] ${text}${truncated ? '…' : ''}`;
}

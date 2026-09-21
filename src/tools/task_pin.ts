/**
 * task_pin — 멀티에이전트 오피스 작업 핀 (claim-check 패턴).
 *
 * 설계 노트 (~/multiagent-office-design.md §9, 2026-06-03):
 *   - 별도 테이블 신설 X. memory 테이블 재활용 + entry_type='task' 로 분리(migration 027).
 *   - append-only: 상태 변경 = 새 행 추가(고쳐쓰기 X). 현재 상태 = 그 pin의 최신 행. 이력 보존.
 *   - 회상 거름망: entry_type='task' 행은 briefing/search에서 제외(별도 단계). 여기선 저장/조회만.
 *   - 핵심함수 insertRawMemory 재사용 안 함 → task 전용 INSERT로 격리(저위험).
 *
 * 저장 형식 (message 첫 줄 = JSON 헤더 + 이후 본문):
 *   create 행:  {"t":"task","from":"쿠우","to":"리브","status":"pending","title":"..."}\n<payload>
 *               → 이 행의 memory.id 가 pin 번호.
 *   update 행:  {"t":"task","pin":70620,"status":"in_progress","note":"..."}
 *               → 헤더의 pin 으로 원 task에 묶임.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as os from "node:os";
import { db } from "../db.js";
import { getDefaultUserId } from "../users.js";
import { resolveAgentIdentity } from "../agent_identity.js";

const DEVICE_NAME = os.hostname();

const STATUSES = ['pending', 'in_progress', 'done', 'failed'] as const;
type Status = typeof STATUSES[number];

function ok(payload: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
function err(message: string, extra?: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }] };
}

interface TaskHeader {
  t: 'task';
  pin?: number;       // update 행만 (create 행은 자기 id가 pin)
  from?: string;
  to?: string;
  status: Status;
  title?: string;
  note?: string;
}

/** message 첫 줄을 JSON 헤더로 파싱. 실패 시 null. */
function parseHeader(message: string): { header: TaskHeader; body: string } | null {
  const nl = message.indexOf('\n');
  const firstLine = nl === -1 ? message : message.slice(0, nl);
  const body = nl === -1 ? '' : message.slice(nl + 1);
  try {
    const h = JSON.parse(firstLine);
    if (h && h.t === 'task' && typeof h.status === 'string') return { header: h as TaskHeader, body };
  } catch { /* not a task header */ }
  return null;
}

function encode(header: TaskHeader, body?: string): string {
  return JSON.stringify(header) + (body ? `\n${body}` : '');
}

/** task 전용 INSERT — entry_type='task', 회상/콜드패스 회피 플래그 고정. */
async function insertTaskRow(opts: {
  userId: number;
  agent_platform: string;
  agent_model: string;
  message: string;
}): Promise<number> {
  const r = await db.query(
    `INSERT INTO memory
       (user_id, agent_platform, agent_model, role, message,
        entry_type, is_pinned, is_active, tag_processed,
        p_tag_id, d_tag, embedding, device_name)
     VALUES ($1, $2, $3, 'assistant', $4,
        'task', FALSE, TRUE, TRUE,
        NULL, '{}', NULL, $5)
     RETURNING id`,
    [opts.userId, opts.agent_platform, opts.agent_model, opts.message, DEVICE_NAME]
  );
  return Number(r.rows[0].id);
}

export function registerTaskPin(server: McpServer): void {
  server.registerTool(
    'task_pin',
    {
      description: `멀티에이전트 작업 핀(task-pin) 저장/갱신/조회 — 팀장 간 작업 라우팅.

action='create': 새 작업 핀 생성. to(받을 팀장)/title 필수. 반환된 pin 번호로 이후 추적.
action='update': 상태 변경 = 새 이력 행 추가(append, 덮어쓰지 않음). pin + status 필수.
action='query': 작업 조회. pin 주면 그 작업의 현재상태+이력, 없으면 전체 작업의 현재상태 목록.

상태 흐름: pending → in_progress → done | failed. 'done'/'failed' 찍으면 그 작업 종료(무한루프 방지).
※ task-pin은 일반 회상(브리핑/검색)에 뜨지 않음 — 이 도구로만 조회.`,
      inputSchema: {
        action: z.enum(['create', 'update', 'query']).describe('동작'),
        to: z.string().optional().describe("create: 받을 팀장 이름 (예: '리브')"),
        from: z.string().optional().describe("create: 보낸 팀장 이름 (생략 시 호출 플랫폼)"),
        title: z.string().optional().describe('create: 작업 한 줄 요약'),
        payload: z.string().optional().describe('create: 작업 명세 본문'),
        pin: z.number().int().optional().describe('update/query: 대상 작업 pin 번호'),
        status: z.enum(STATUSES).optional().describe('update: 새 상태'),
        note: z.string().optional().describe('update: 상태 변경 메모'),
        agent_platform: z.string().optional(),
        agent_model: z.string().optional(),
      },
    },
    async (args) => {
      const userId = await getDefaultUserId();
      const id = resolveAgentIdentity(server, args);

      // ── create ──
      if (args.action === 'create') {
        if (!args.to) return err("create: 'to' (받을 팀장) is required");
        if (!args.title) return err("create: 'title' is required");
        const header: TaskHeader = {
          t: 'task',
          from: args.from ?? id.agent_platform,
          to: args.to,
          status: 'pending',
          title: args.title,
        };
        const pin = await insertTaskRow({
          userId,
          agent_platform: id.agent_platform,
          agent_model: id.agent_model,
          message: encode(header, args.payload),
        });
        return ok({ ok: true, action: 'create', pin, status: 'pending', from: header.from, to: header.to, title: header.title });
      }

      // ── update (append 이력 행) ──
      if (args.action === 'update') {
        if (args.pin == null) return err("update: 'pin' is required");
        if (!args.status) return err("update: 'status' is required");
        // 원 작업 존재 확인
        const orig = await db.query(
          `SELECT id FROM memory WHERE id = $1 AND user_id = $2 AND entry_type = 'task' AND is_active = TRUE`,
          [args.pin, userId]
        );
        if (orig.rows.length === 0) return err("update: task pin not found", { pin: args.pin });
        const header: TaskHeader = { t: 'task', pin: args.pin, status: args.status, note: args.note };
        const rowId = await insertTaskRow({
          userId,
          agent_platform: id.agent_platform,
          agent_model: id.agent_model,
          message: encode(header),
        });
        return ok({ ok: true, action: 'update', pin: args.pin, status: args.status, history_row: rowId });
      }

      // ── query ──
      // entry_type='task' 행 전부 모아 pin 별로 그룹핑 → 최신 status collapse.
      const rows = await db.query(
        `SELECT id, message, created_at FROM memory
          WHERE user_id = $1 AND entry_type = 'task' AND is_active = TRUE
          ORDER BY created_at ASC`,
        [userId]
      );

      interface PinAgg { pin: number; from?: string; to?: string; title?: string; status: Status; updated_at: any; history: any[]; }
      const byPin = new Map<number, PinAgg>();
      for (const r of rows.rows) {
        const parsed = parseHeader(r.message);
        if (!parsed) continue;
        const h = parsed.header;
        const pin = h.pin ?? Number(r.id);   // create 행은 자기 id가 pin
        let agg = byPin.get(pin);
        if (!agg) {
          agg = { pin, status: h.status, updated_at: r.created_at, history: [] };
          byPin.set(pin, agg);
        }
        // create 행(헤더에 pin 없음)에서 메타 채움
        if (h.pin == null) {
          agg.from = h.from; agg.to = h.to; agg.title = h.title;
        }
        // 시간순(ASC)이라 마지막에 본 게 최신 상태
        agg.status = h.status;
        agg.updated_at = r.created_at;
        agg.history.push({ row: Number(r.id), status: h.status, note: h.note, body: parsed.body || undefined, at: r.created_at });
      }

      if (args.pin != null) {
        const agg = byPin.get(args.pin);
        if (!agg) return err("query: task pin not found", { pin: args.pin });
        return ok({ ok: true, action: 'query', task: agg });
      }
      // 전체: 현재상태 목록 (이력 제외, 가벼움)
      const list = [...byPin.values()].map(({ history, ...rest }) => rest)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return ok({ ok: true, action: 'query', count: list.length, tasks: list });
    }
  );
}

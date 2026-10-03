/**
 * 사람이 반려한 별칭 제안을 다시 올리지 않는 규칙 — 판단만 한다(DB 없음, 검사 스크립트가 바로 부른다).
 *
 * 왜: 제안기는 실행마다 점수 높은 후보 몇 쌍(기본 12)만 판정한다. 사람이 반려해도 그 쌍의 점수는
 * 그대로라 같은 제안이 다시 대기열에 오르고(#332 반려 → 사흘 뒤 같은 쌍 #407), 그 자리를 차지해
 * 새 후보가 밀린다.
 *
 * 규칙 (2026-10-03 형 결정: 영구 차단):
 *   - 사람(decided_by='user')이 반려한 같은 방향(source→target)은 다시 올리지 않는다. 기한 없음.
 *     생각이 바뀌면 사람이 set_alias로 직접 건다 (그 경로는 이 규칙을 거치지 않는다).
 *   - 반려 뒤 그 쌍을 한 번 더 판정하되, 대기열에 오를 수 있는 건 반대 방향 결과뿐이다 (실례:
 *     pacefy→pacefy-e2503 반려 뒤 pacefy-e2503→pacefy가 올라와 승인됨). 가장 최근 반려 뒤 이 쌍에 행이
 *     하나라도 생겼으면 그 기회는 쓴 것이라 판정 전에 뺀다. 양방향 다 사람이 반려했어도 판정 전에 뺀다.
 *   - 시스템이 스스로 반려한 것(순환 등)은 막지 않는다 — 상황이 바뀌면 맞을 수 있다.
 * "반려 뒤 새 근거(사람의 명시 발언)가 있으면 다시"는 쓰지 않는다: 명시 발언 탐지(패턴 단어 + 태그명
 * 부분일치)가 헐거워서 태그 정리 얘기만 해도 근거로 잡힌다 (실측: 사람 글만·단어 단위로 좁혀도
 * 30일 동안 반려 쌍 8개가 '근거 있음').
 *
 * 쌍은 별칭을 따라간 정본 id로 비교한다 — 나중에 한쪽이 다른 태그의 별칭이 돼도 같은 쌍으로 본다.
 */

export interface PairHistoryRow {
  id: number;
  /** 정본 id (canonical_project_tag_id) */
  sourceId: number;
  targetId: number;
  status: string;
  decidedBy: string | null;
  /** COALESCE(decided_at, updated_at, created_at) */
  decidedAt: Date;
  createdAt: Date;
  /** 사람이 set_alias로 직접 건 행 (적용 직전 잠깐 대기 상태) — 정리하지 않는다 */
  manual: boolean;
}

export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** 쌍(방향 무관)별로 묶는다. 정본이 같아진 행(이미 합쳐진 쌍)은 버린다. */
export function groupPairHistory(rows: PairHistoryRow[]): Map<string, PairHistoryRow[]> {
  const out = new Map<string, PairHistoryRow[]>();
  for (const r of rows) {
    if (r.sourceId === r.targetId) continue;
    const k = pairKey(r.sourceId, r.targetId);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

const isUserRejection = (r: PairHistoryRow) => r.status === "rejected" && r.decidedBy === "user";

/** 사람이 이 방향을 반려했으면 가장 최근 그 제안 id, 아니면 null. */
export function userRejectedDirection(
  rows: PairHistoryRow[] | undefined,
  sourceId: number,
  targetId: number
): number | null {
  let hit: PairHistoryRow | null = null;
  for (const r of rows ?? []) {
    if (!isUserRejection(r) || r.sourceId !== sourceId || r.targetId !== targetId) continue;
    if (!hit || r.decidedAt.getTime() > hit.decidedAt.getTime()) hit = r;
  }
  return hit ? hit.id : null;
}

/** 판정 전에 뺄 쌍인지 — 판정해도 올릴 수 있는 결과가 없거나, 반려 뒤 한 번 기회를 이미 썼으면. */
export function skipBeforeJudge(rows: PairHistoryRow[] | undefined): boolean {
  const all = rows ?? [];
  const rejections = all.filter(isUserRejection);
  if (rejections.length === 0) return false;
  const { sourceId: a, targetId: b } = rejections[0];
  if (userRejectedDirection(all, a, b) !== null && userRejectedDirection(all, b, a) !== null) return true;
  const lastRejection = Math.max(...rejections.map((r) => r.decidedAt.getTime()));
  return all.some((r) => !isUserRejection(r) && r.createdAt.getTime() > lastRejection);
}

/** 대기 중인데 사람이 반려한 방향을 되풀이하는 제안 (규칙이 생기기 전·배포 전 옛 코드가 올린 것). */
export function repeatsToSweep(rows: PairHistoryRow[] | undefined): Array<{ pendingId: number; rejectedId: number }> {
  const out: Array<{ pendingId: number; rejectedId: number }> = [];
  for (const r of rows ?? []) {
    if (r.status !== "pending" || r.manual) continue;
    const rejectedId = userRejectedDirection(rows, r.sourceId, r.targetId);
    if (rejectedId !== null) out.push({ pendingId: r.id, rejectedId });
  }
  return out;
}

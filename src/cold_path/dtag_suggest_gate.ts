/**
 * 새 프로젝트 태그 제안 규칙 — 판단만 한다(DB 없음, 검사 스크립트가 바로 부른다).
 *
 * 규칙 (2026-10-03 형 결정: 바로 만들지 말고 물어보기):
 *   - 자주 쓰인 d_tag가 아직 프로젝트 태그가 아니면 project_tags에 넣지 않고 제안만 남긴다.
 *   - 사람이 승인해야 태그가 생기고, 그 이름의 d_tag를 가진 글에만 붙는다.
 *   - "추천대로"는 사람에게 보여 준 제안 번호만 처리한다: project=승인, generic=반려, unsure=그대로 둠.
 */

export type Recommendation = "project" | "generic" | "unsure";

/** d_tag 비교용 정규화 — 저장된 d_tag와 똑같이(소문자·앞뒤 공백 제거만) 맞춘다. */
export function normalizeTag(name: unknown): string {
  return String(name ?? "").toLowerCase().trim();
}

export function parseRecommendation(value: unknown): Recommendation | null {
  return value === "project" || value === "generic" || value === "unsure" ? value : null;
}

export interface PendingForApply {
  id: number;
  status: string;
  recommendation: Recommendation | null;
}

export interface ApplyPlan {
  confirm: number[];
  reject: number[];
  /** unsure·추천 없음 — 사람이 따로 골라야 한다 */
  keep: number[];
  /** 대기 중이 아니거나 없는 번호 */
  skipped: number[];
}

export function planApplyRecommendations(ids: number[], rows: PendingForApply[]): ApplyPlan {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const plan: ApplyPlan = { confirm: [], reject: [], keep: [], skipped: [] };
  for (const id of [...new Set(ids)]) {
    const row = byId.get(id);
    if (!row || row.status !== "pending") plan.skipped.push(id);
    else if (row.recommendation === "project") plan.confirm.push(id);
    else if (row.recommendation === "generic") plan.reject.push(id);
    else plan.keep.push(id);
  }
  return plan;
}

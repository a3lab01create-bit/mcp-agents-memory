/**
 * d_tag 승격 제안 규칙 — 판단만 한다(DB 없음, 검사 스크립트가 바로 부른다).
 *
 * 왜: 승격기가 자주 쓰인 d_tag를 project_tags에 바로 넣어서 일반어와 합성어가 프로젝트 태그로 쌓였다.
 * 실측(08-01~10-03 승격 130건): 66건은 클러스터러가 지어낸 이름(bug-fix-code-review·oauth-workflow…)이라
 * 어떤 d_tag와도 맞지 않아 소급 태깅 0행, 나머지 64건도 대부분 일반어(bug·fix·save·upload…).
 *
 * 규칙 (2026-10-03 형 결정: 바로 만들지 말고 물어보기):
 *   - 대표 이름은 실제로 쓰인 d_tag여야 한다. 클러스터러가 지어낸 이름은 버린다.
 *   - 이미 프로젝트 태그인 이름은 다른 클러스터의 멤버가 될 수 없다(그 이름은 자기 대표로 남는다).
 *   - 사람이 반려한 이름은 대표도 멤버도 못 된다 — 그 클러스터는 지어낸 이름처럼 풀어서 멤버를 각자 남긴다
 *     (반려한 `cafe24-api`가 멤버 `cafe24`까지 가리지 않게).
 *   - 새 이름은 project_tags에 넣지 않고 제안만 남긴다. 사람이 승인해야 태그가 생긴다.
 *   - 태그는 그 이름의 d_tag에만 붙인다. 클러스터 멤버는 횟수 합산에만 쓴다 — 사람은 이름만 보고 승인하니까.
 *   - "추천대로"는 사람에게 보여 준 제안 번호만 처리한다: project=승인, generic=반려, unsure·추천 없음=그대로 둠.
 */

export type Recommendation = "project" | "generic" | "unsure";

export interface RawCluster {
  canonical: string;
  members: string[];
}

export interface Cluster {
  canonical: string;
  members: string[];
  total: number;
}

/** d_tag 비교용 정규화 — 저장된 d_tag와 똑같이(소문자·앞뒤 공백 제거만) 맞춘다. */
export function normalizeTag(name: unknown): string {
  return String(name ?? "").toLowerCase().trim();
}

export interface ClusterRules {
  /** 이미 project_tags에 있는 이름 — 남의 멤버가 될 수 없다 */
  reserved?: Set<string>;
  /** 사람이 반려한 이름 — 대표도 멤버도 될 수 없다 */
  rejected?: Set<string>;
}

/**
 * 클러스터러 출력을 입력 d_tag에 묶는다. 대표 이름이 입력에 없거나 반려된 이름이면 그 클러스터를 버리고,
 * 멤버도 입력에 있는 것만 남기며, 대표 이름은 항상 멤버에 넣는다. 같은 대표가 둘이면 합친다.
 * 한 d_tag는 한 클러스터에만 들어간다(먼저 나온 클러스터 우선) — 합산이 부풀지 않게.
 * 어느 클러스터에도 안 들어간 입력 d_tag는 단독 클러스터가 된다(클러스터러가 빠뜨려도 잃지 않게).
 * 반려된 이름은 어디에도 안 들어간다 — 그 이름이 다른 길로 태그가 됐어도 소급 태깅이 돌지 않게.
 */
export function normalizeClusters(raw: RawCluster[], freq: Map<string, number>, rules: ClusterRules = {}): Cluster[] {
  const reserved = rules.reserved ?? new Set<string>();
  const rejected = rules.rejected ?? new Set<string>();
  const byCanonical = new Map<string, Set<string>>();
  const claimed = new Set<string>();
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || typeof c !== "object") continue;
    const canonical = normalizeTag(c.canonical);
    if (!freq.has(canonical) || rejected.has(canonical)) continue;
    // 앞 클러스터의 멤버로 이미 들어간 이름이면 두 번 세지 않는다
    if (claimed.has(canonical) && !byCanonical.has(canonical)) continue;
    const members = byCanonical.get(canonical) ?? new Set<string>([canonical]);
    for (const m of Array.isArray(c.members) ? c.members : []) {
      const tag = normalizeTag(m);
      if (!freq.has(tag) || claimed.has(tag) || rejected.has(tag)) continue;
      if (tag !== canonical && reserved.has(tag)) continue;
      members.add(tag);
    }
    byCanonical.set(canonical, members);
    for (const m of members) claimed.add(m);
  }
  for (const tag of freq.keys()) {
    if (!claimed.has(tag) && !rejected.has(tag)) byCanonical.set(tag, new Set([tag]));
  }
  return [...byCanonical].map(([canonical, members]) => ({
    canonical,
    members: [...members],
    total: [...members].reduce((sum, m) => sum + (freq.get(m) ?? 0), 0),
  }));
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

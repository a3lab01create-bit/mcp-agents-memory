/**
 * 프로젝트 명부(registry) 모드에서 태거의 p_tag 답을 받아들일지 — 판단만 한다(DB 없음, 검사 스크립트가 바로 부른다).
 * DEVLOG §24 L1.
 *
 * 명부 모드 규칙:
 *   - 답이 명부 이름이거나 명부 이름의 별칭이면(별칭을 따라간 정본이 명부에 있으면) 받아들인다.
 *   - 명부 밖 이름(옛 일반어 태그 포함)은 받지 않는다 → p_tag NULL. 옛 태그가 아직 있어도 마찬가지다.
 *   - `NEW:<이름>`은 만들지 않는다 → p_tag NULL. 새 프로젝트는 사람이 명부에 올린다.
 * 명부 모드가 아니면 이 판단을 쓰지 않는다(태거의 기존 경로 그대로).
 */

/**
 * 명부 소속 판정 SQL (한 곳에서만 정의). 별칭 행은 명부가 아니다 — 명부 항목이 별칭이 되면 명부에서 빠진 것으로 본다.
 * 테이블 별칭 없이 쓰는 조각이라 `FROM project_tags` 바로 뒤 WHERE에 넣는다.
 */
export const REGISTRY_MEMBER_SQL = "kind IS NOT NULL AND alias_of IS NULL";

/**
 * 명부 칼럼이 아직 없다(마이그레이션 031 전) — 이 경우에만 예전 방식으로 돌아간다.
 * 다른 오류(연결 끊김·잠금 대기 등)는 예전 방식으로 바꾸지 않고 그대로 던진다: 잠깐의 DB 오류로 5분 동안 예전
 * 방식(새 태그 생성 포함)이 되면 안 된다. 호출자(워커·manage_knowledge·승격기)는 이미 오류를 다시 시도한다.
 */
export function isUndefinedColumn(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "42703";
}

export type PTagAnswer =
  | { type: "none" }
  | { type: "new"; name: string }
  | { type: "name"; slug: string };

/** 태거 JSON의 p_tag 값을 나눈다. 문자열이 아니거나 비어 있으면 none. */
export function parsePTagAnswer(raw: unknown): PTagAnswer {
  if (typeof raw !== "string") return { type: "none" };
  const value = raw.trim();
  if (!value || value.toLowerCase() === "null") return { type: "none" };
  if (value.startsWith("NEW:")) {
    const name = value.slice(4).trim().toLowerCase();
    return name ? { type: "new", name } : { type: "none" };
  }
  return { type: "name", slug: value.toLowerCase() };
}

export type RegistryVerdict =
  | { accept: number; reason: "registry" }
  | { accept: null; reason: "no_answer" | "new_not_allowed" | "unknown_name" | "not_in_registry" };

/**
 * @param canonicalId 답 이름을 별칭 사슬로 따라간 정본 id (그런 태그가 없으면 null)
 * @param registryIds 명부(kind가 있는 정본 태그) id
 */
export function registryVerdict(
  answer: PTagAnswer,
  canonicalId: number | null,
  registryIds: ReadonlySet<number>
): RegistryVerdict {
  if (answer.type === "none") return { accept: null, reason: "no_answer" };
  if (answer.type === "new") return { accept: null, reason: "new_not_allowed" };
  if (canonicalId == null) return { accept: null, reason: "unknown_name" };
  if (!registryIds.has(canonicalId)) return { accept: null, reason: "not_in_registry" };
  return { accept: canonicalId, reason: "registry" };
}

/** 명부 모드 태거 user prompt의 후보 줄. 설명이 있으면 `이름: 설명`. */
export function registryCandidateLines(candidates: Array<{ name: string; description: string | null }>): string {
  return candidates
    .map((c) => (c.description && c.description.trim() ? `- ${c.name}: ${c.description.trim()}` : `- ${c.name}`))
    .join("\n");
}

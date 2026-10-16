/**
 * project_alias_promoter 의 후보·증거 판정 (순수 함수 — DB·모델 호출 없음).
 * 사람이 반려한 쌍을 막는 쪽은 alias_reject_gate.ts, 여기는 **올라오기 전** 단계다.
 *
 * ## 1) 명부 가드
 * `manage_project_tags` 의 적용 경로에는 "source 가 명부(kind)에 있으면 거부" 가드가 있는데
 * (별칭으로 만들면 명부에서 조용히 빠지니까) 후보를 **만드는** 쪽은 kind 를 아예 읽지 않았다.
 * 그래서 절대 "예"가 될 수 없는 질문이 사람 앞에 올라왔다 (2026-10-12 A559: mcp-agents-memory ↔
 * marketadmin — 둘 다 명부 등록 프로젝트).
 *   - 생성 때: 둘 다 명부면 버린다 (어느 방향도 적용 불가 = 물어볼 가치가 없다).
 *   - 방향이 정해진 뒤: 최종 source 가 명부면 올리지 않는다 (적용 가드와 같은 조건).
 * 생성 시점의 source 는 건수로 임시 정한 방향이라, 거기서 "source 가 명부면 버린다"로 막으면
 * `잡동사니태그 → 명부프로젝트`(합쳐야 맞는 방향)까지 날아간다. 그래서 자리를 둘로 나눴다.
 *
 * ## 2) explicit_user_statement 증거
 * 가중치가 가장 큰 신호(100)인데 거짓 증거가 세 경로로 들어왔다 — 2026-10-12 실측
 * (explicit 신호가 붙은 제안 46건 = confirmed 17 · rejected 29, 증거행 1,146건):
 *   ① 봉투. 버즈 턴은 `<context>` 안에 그 채널의 `Project slug:` 줄을 품고 있어서, 그 줄이
 *      "사용자가 두 태그를 같이 말했다"로 집계됐다. A559 증거 14건 중 12건이 이 모양이고,
 *      판정 모델에 넘어가는 본문 700자도 전부 봉투 머리글이었다 ("marketadmin 을 프로젝트
 *      슬러그로 명시했다"는 모델 근거가 거기서 나왔다).
 *   ② 자기 p_tag. 그 메모에 붙은 p_tag 를 "언급 1개"로 셌다. p_tag 는 태거가 만든 파생값이라,
 *      태거의 오분류가 "두 태그는 같다"는 증거로 되돌아오는 순환이 된다 (A559 증거 2건은
 *      본문에 `mcp-agents-memory` 글자가 아예 없고 p_tag 때문에만 쌍이 생겼다).
 *   ③ `%이제%로%`. 구가 아니라 "이제 뒤 어디든 로"라서 아무 한국어 문서에나 걸린다
 *      (증거행 1,146 중 561건). 거리를 묶어도(≤20/40/80자) 되살아나는 제안이 없어서 뺀다.
 *
 * 실측 결과: confirmed 유지 16→12 · rejected 유지 28→20 · 증거행 881→253.
 * ①②만으로는 confirmed 손실 0 (16→16), rejected 28→24. ③이 confirmed 4건의 explicit 근거를
 * 지우는데 (npm-publish→npm · thread→slack-thread · config→configuration · ios-build→ios)
 * 네 쌍 다 name_similarity 0.780 ≥ 문턱(0.45/0.55) 이라 후보로는 그대로 잡힌다.
 *
 * ⚠️ 같이 재보고 **버린** 안 — 숫자를 남겨둔다. 다시 제안하지 말 것:
 *   - 이름 경계 검사(한 이름이 다른 이름의 조각으로 잡히는 것 차단): confirmed 유지 16→5.
 *     `debug`⊂`debugging` · `config`⊂`configuration` · `ios`⊂`ios-build` 처럼 **이름이 서로
 *     포함되는 병합이 정상 집합**이다 (2026-10-02 승인 11건이 그 모양).
 *   - 구와 두 이름을 160자 창 안에 요구: 16→1. 같은 줄 요구: 16→0. 게다가 A559 는 같은 줄
 *     조건에서도 살아남는다 — 맞은 걸 다 죽이면서 틀린 건 못 잡는 필터다.
 * 상세: DEVLOG §25.
 */
import { buzzEmbeddingText } from "../auto_save/buzz_envelope.js";

/** "두 태그가 같은 것"이라는 사람 말에 실제로 들어가는 구. SQL 선별기와 TS 재검사가 같은 목록을 쓴다. */
export const EXPLICIT_PHRASES: readonly string[] = [
  "이름 바꿈",
  "이름바꿈",
  "이름을 바꿈",
  "개명",
  "같은 프로젝트",
  "동일",
  "합쳐",
  "합치",
  "별칭",
  "동의어",
  "rename",
  "renamed",
  "now called",
  "same as",
  "alias",
];

/** 위 구를 그대로 SQL LIKE 패턴으로. 느슨한 선별기이고, 정밀 판정은 TS 쪽에서 다시 한다. */
export const EXPLICIT_LIKE_PATTERNS: string[] = EXPLICIT_PHRASES.map((phrase) => `%${phrase}%`);

/** 명부 판정에 필요한 최소 정보. */
export interface RegistryTagInfo {
  id: number;
  kind?: string | null;
}

/** 이름으로 언급을 찾을 때 필요한 최소 정보. */
export interface NamedTagInfo {
  id: number;
  name: string;
}

/** 명부(project/category)에 올라간 태그인가. 적용 경로의 registrySourceError 와 같은 조건. */
export function isRegistryTag(tag: RegistryTagInfo | undefined | null): boolean {
  return tag?.kind != null;
}

/** 둘 다 명부면 어느 방향으로도 적용할 수 없다 → 후보로 만들지 않는다. */
export function bothInRegistry(
  a: RegistryTagInfo | undefined | null,
  b: RegistryTagInfo | undefined | null
): boolean {
  return isRegistryTag(a) && isRegistryTag(b);
}

/**
 * 판정 모델에게 보여줄 사람 말 — 버즈 봉투(`<context>`·이벤트 머리글)를 벗긴다.
 * 임베딩 입력과 같은 변환이다. 봉투가 아니면 받은 그대로 돌려준다.
 * (봉투의 프로젝트 슬러그는 **태깅엔 도움**이라 저장 본문에는 일부러 남아 있다 — 벗기는 건
 *  alias 판정 경로뿐이다. buzz_envelope.ts 의 buzzEmbeddingText 주석 참고.)
 */
export function aliasEvidenceText(message: string): string {
  return buzzEmbeddingText(message);
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function compactText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 글 한 편의 비교용 형태 — 태그마다 다시 만들지 않는다.
 * 명부 태그가 120개까지 오고 글은 수만 자라, 태그마다 전문을 정규화하면 한 번 실행에 수 GB를 훑는다.
 */
interface TextForms {
  lower: string;
  normalized: string;
  compact: string;
}

function textForms(text: string): TextForms {
  return { lower: text.toLowerCase(), normalized: normalizeText(text), compact: compactText(text) };
}

function mentionsIn(forms: TextForms, name: string): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName.length >= 3 && forms.lower.includes(lowerName)) return true;

  const normalizedName = normalizeText(name);
  if (normalizedName.length >= 3 && forms.normalized.includes(normalizedName)) return true;

  const compactName = compactText(name);
  return compactName.length >= 3 && forms.compact.includes(compactName);
}

/** 글에 그 태그 이름이 나오나 (하이픈·공백 차이는 흡수). */
export function messageMentionsTag(message: string, name: string): boolean {
  return mentionsIn(textForms(message), name);
}

export function containsExplicitPhrase(text: string): boolean {
  return hasPhrase(text.toLowerCase());
}

function hasPhrase(lowerText: string): boolean {
  return EXPLICIT_PHRASES.some((phrase) => lowerText.includes(phrase.toLowerCase()));
}

export interface ExplicitEvidence {
  /** 봉투를 벗긴 본문 — 증거로 저장하고 판정 모델에도 이 텍스트를 넘긴다. */
  text: string;
  /** 그 본문이 이름으로 언급한 태그 id. 구가 없으면 빈 배열. */
  tagIds: number[];
}

/**
 * 이 글이 어느 태그들에 대한 "사람 말" 증거인가.
 * 봉투를 벗긴 본문에 구가 남아 있고, 그 본문이 이름을 쓴 태그만 센다.
 * 자기 p_tag 는 세지 않는다 (위 ② 순환).
 */
export function explicitEvidence(
  message: string,
  tags: Iterable<NamedTagInfo>
): ExplicitEvidence {
  const text = aliasEvidenceText(message);
  const lower = text.toLowerCase();
  if (!hasPhrase(lower)) return { text, tagIds: [] };

  const forms: TextForms = { lower, normalized: normalizeText(text), compact: compactText(text) };
  const tagIds: number[] = [];
  for (const tag of tags) {
    if (mentionsIn(forms, tag.name)) tagIds.push(tag.id);
  }
  return { text, tagIds };
}

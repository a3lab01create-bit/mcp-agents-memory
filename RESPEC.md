**모티브**

[supermemory.io](http://supermemory.io)

hermes-agent



**기본 메모리**



사람의 기억을 모티브

- 기본적으로 모든 대화를 시간 순서로 모두 자동 저장 --> 시간이 지나면 tag에 따른 주요내용만 간추리고 오래된기억은 archive
- platform 과 model 로 분류하면 특별한 분류 없이도 모델별 기억으로 분류가능 



memory 테이블



user_id:

agent_platform : claude-code / codex / chatgpt / hermes-agent / openclaw 등

agent_model : opus-4-7 / gemini-3-pro / gpt-5.5 등

subagent : yes / no

subagent_model : 

subagent_role : 

message : 

p_tag: predefined

d_tag: dynamic

embedding:

created_at:

updated_at:



user 테이블

use_id:

user_name:

core_profile: 아주 중요한 핵심 사용자 정보

sub_profile: 그외 기억해야할 사용자 정보

created_at : 

updated_at:







**투 트랙 비동기(Asynchronous) 설계**



**트랙 1: 메인 대화 (Hot Path) - 초고속 처리**

- **역할:** 대화의 흐름이 끊기지 않게 하는 데만 집중합니다.
- **동작:** 메시지가 발생하면 일단 raw memory 텍스트만 시간 순서대로 DB에 휙 던져 넣습니다. 태깅이고 임베딩이고 신경 쓰지 않고 바로 다음 대화를 이어갑니다.

**트랙 2: 백그라운드 사서 (Cold Path) - 여유로운 정리**

- **역할:** 뒤에서 조용히 데이터를 정제합니다.
- **동작:** * 사서(Librarian)는 메인 대화와 철저히 분리되어 백그라운드에서 대기합니다.
  - 태깅이나 임베딩이 안 된 raw memory가 쌓여 있으면, 1분 단위나 메시지 5개 단위로 묶어서 스윽 가져갑니다.
  - 가져온 데이터를 2.5-flash로 태깅하고 3-large로 임베딩한 뒤, DB의 빈칸(p_tag, d_tag, embedding)을 업데이트(Update) 해줍니다.

DB를 체크하는 스케줄러(예: setInterval이나 node-cron) 방식으로 가볍게



**메모리 로드시**

- 기본적으로 memory 테이블의 platorm model subagent 정보를 기준으로 직접적으로 기억이 관련있는 모델의 기억만 해당 (관련 프로젝트기억 일 경우 협업 agent 의 기억까지 포함)
- 단기 메모리 최근 2-3일 (최근 3일의 대화 OR 최대 8,000토큰 중 먼저 도달하는 것)
- 이외 필요한 메모리는 필요시 archive 된 상태에서 찾아서 가지고옴 *"ex)사용자가 몇일전에 이야기 했는데 ...." 라고 진행할시 가져오기 혹은 과거의 기록이 필요하다고 생각될시 날짜, tag 및 메세지 내용 기반 키워드 찾기(2.5-flash 태깅모델 같이사용하면 괜찮을듯)





**Embedding & Tag** 



EMBEDDING

모델 :text-embedding-3-large



TAG 

모델 : gemini-2.5-flash 

방식: predefined & dynamic 

*predefined 의 경우는 대화시 진행하는 프로젝트 기준으로 등록 predefined tag 도 모델이 생성

old_error 메세지 d_tag 관련

tag: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [429 Too Many Requests] You exceeded your current quota, pleas...


### grok-4-1-fast-reasoning / grok-4-1-fast-non-reasoning
#### Input
Tokens $0.20/ 1M tokens Cached tokens $0.05/ 1M tokens
#### Output
Tokens $0.50/ 1M tokens



**Librarian**

- memory table 에서 필요한 user 테이블용 정보를 선별해서 user 테이블에 저장





**Skill 정리**

- 고민중...





**Tool**

이전 작업 과정이나 사용과정에서 우리가 경험했던 툴이 너무 많으면 1-2개 빼고 잘 사용을 안한다 라는 점을 생각해서 툴을 적은 수로 유지하고 파라미터같은 걸 다양화하기 (아래는 예시)



**1.** **search_memory** **(조회/검색 스킬 하나로 통합)** 과거 기억 검색과 프로젝트 컨텍스트 로드를 하나로 합칩니다. 에이전트에게 "기억 안 나면 무조건 이거 하나만 써"라고 쥐어주는 겁니다.

- **파라미터:**
  - query (string, optional): 찾고 싶은 내용
  - p_tag (string, optional): 특정 프로젝트로 한정할 때
  - date_range (string, optional): 기간 한정
- **효과:** 에이전트가 알아서 파라미터 조합만 바꿔가며 검색을 수행하므로 툴 선택의 혼란이 없습니다.

**2.** **manage_knowledge** **(저장/수정 스킬 하나로 통합)** 강제 기억, 망각, 프로필 업데이트 등을 하나의 관리 툴로 묶어버립니다.

- **파라미터:**
  - action (enum: 'add', 'update', 'remove')
  - target (enum: 'sub_profile', 'memory')
  - content (string): 저장할 내용
- **효과****:** 사용자가 명시적으로 무언가를 기억하라고 하거나 지우라고 할 때, 하나의 창구에서 action 값만 바꿔서 처리하게 됩니다.



**쿠 보완 기획**



**(1) 회의 결과 — vision 결정사항 7건** (form + Gemini 회의, 4-29)

| # | 결정 | 이유 |
|---|---|---|
| 1 | **Archive = `is_active=false` + `archived_at` 컬럼 (단일 테이블 soft delete)** | 별도 테이블로 분리하면 vector search 시 단기/장기 동시 훑기 불편. JOIN/UNION 무거워짐. pgvector 인덱스도 단일 테이블이 효율적. |
| 2 | **"관련 프로젝트" 자동 판단 = `p_tag` 매칭 1순위** | cwd는 multi-repo에서 끊김. 발화 시 매번 명시 = 사용자 피로도 높음. Librarian이 단 p_tag 기준으로 협업 agent 기억 묶어오기가 가장 자연스러움. |
| 3 | **Hot path 저장 대상 = User + Assistant 둘 다, `role` 컬럼으로 구분** | 사용자 말만 저장하면 "내가 그때 뭐라 답했지?" 맥락 손실. |
| 4 | **`manage_knowledge` target='memory' = importance bump + archive 면제 (`is_pinned=true`)** | 자동 저장과 차별. 사용자가 명시한 강제 기억은 시스템 프롬프트에 준하는 사실로 영구 보존, Cold Path 요약/삭제 대상에서 제외. |
| 5 | **p_tag 라이프사이클 = Cold Path 사서가 동적 제안 + `project_tags` 테이블 누적 (하이브리드)** | 프로젝트 시작 1회 수동 등록은 인간이 까먹음. 사서가 새 주제 감지 시 신규 p_tag 생성, 사후 관리 툴로 병합/삭제 가능. |
| 6 | **subagent 깊이 = 1-level만 추적 (메인 vs sub)** | N-level chain은 시각화는 멋있어도 LLM 맥락 주입 시 토큰 낭비 + 노이즈 (할루시네이션 원인). |
| 7 | **기존 ~3000 row 처리 = 새 schema 마이그레이션 + 3-large re-embed + archive 상태 보존** | 3000 건 기준 비용 ~$0.15, 시간 몇 분. 차원(1536↔3072) 섞이면 쿼리 박살. 깔끔히 한 번에 밀고 가는 게 정신건강. |

**(1-A) 위 결정 보완 nuance — 쿠 짚음** (구현 시 누락 시 위험)

- **(2번) chicken-and-egg**: p_tag는 Cold Path가 채움 → Hot Path 저장 직후엔 NULL. 그 윈도우(최대 1분 / 5메시지)에 검색 시 p_tag 매칭 작동 X.  
  → 방어: Cold Path latency 짧게 유지 + p_tag NULL 시 cwd를 **soft hint** fallback (1순위 p_tag, 2순위 cwd).
- **(3번) Assistant 발화 hallucination 위험**: 이전 cleanup 이유였던 "User is a Staff Engineer" 같은 추측이 form profile로 박힌 path가 정확히 이거. role 컬럼으로 구분만 하는 걸론 부족.  
  → 방어 3단:  
  ① Cold Path tagger prompt에 role 정보 명시 ("아래는 assistant 발화. user 사실로 단정 X")  
  ② Librarian (memory → user 테이블 promote) 시 `role='user'` source만 사용 또는 강하게 가중  
  ③ `search_memory`에 role 필터 옵션 (기본 둘 다, "내가 뭐라 했지?"는 `role='user'` 강제)
- **(5번) p_tag explosion 위험**: flash가 동의어 분리해서 새 tag 만드는 함정 (예: "centragens" / "Centrazen 프로젝트" / "센트라젠 작업").  
  → 방어: tagger prompt에 "기존 `project_tags` 후보 보고 의미 일치하면 그대로 사용, 정말 새 주제일 때만 신규" 패턴 + `project_tags`에 `alias_of` 컬럼 (사후 병합 용)

**(2) 구현 detail — 회의 2차 결정사항 (Gemini + 쿠, 4-29)**

| # | 결정 | 이유 |
|---|---|---|
| a | **토큰 카운팅 = char-approximate** (`char_count / 1.7` 정도, 8000 token ≈ 12000-16000자) | Hot Path 제1원칙 = 초고속. tiktoken은 매 메시지 호출 시 이벤트 루프 부하. 한영 혼용 평균 1.5-2자/token 러프 추정으로 충분. |
| b | **`manage_knowledge` = 즉시 sync tag + embed** | 사용자가 명시 강제 기억 후 바로 써먹으려 하는데 Cold Path 안 돌아서 DB 반영 X면 치명적 UX 실패. Hot Path에 실시간 꽂기. |
| c | **`search_memory` = vector → cosine 임계값 미만 시 ILIKE fallback** (env로 threshold tunable, 시작 0.3) | 3-large는 0건 거의 안 뱉음. 엉뚱해도 낮은 유사도 반환. 임계값 미만 = "의미 검색 실패"로 간주하고 ILIKE로 fallback. |
| d | **`subagent_role` = free-form string + convention 예시** | 외부 플랫폼들이 어떤 role 이름 던질지 미리 못 정함. enum으로 옥죄면 파싱 에러. 저장 시 lowercase+trim normalize, convention 예시 (researcher / implementer / reviewer / qa / advisor) 박아두면 자연스럽게 align. |
| e | **embedding 차원 마이그레이션** (회의 결정 7번에서 자동 도출) | pgvector 컬럼 `vector(3072)`로 변경 + HNSW 인덱스 재생성. 기존 ~3000 row는 3-large로 re-embed (비용 ~$0.15). |

**(2-A) 결정 보완 nuance — 쿠 짚음**

- **(b번) sync 실패 처리**: tag/embed API 실패해도 raw 저장은 무조건 성공 보장. 응답에 `{stored: true, tagged: 'ok'|'pending', embedded: 'ok'|'pending'}` 노출. 빈칸이면 Cold Path가 다음 사이클에 자동 처리.
- **(c번) 임계값 tunable**: 0.3은 시작점. text-embedding-3-large 실제 분포 보고 조정 필요. `SEARCH_FALLBACK_THRESHOLD` env var로 빼서 form이 사용 중 조정 가능 (단기/장기 전환 기간 tunable과 같은 패턴).
- **(d번) role normalize**: `INSERT` 시 `lower(trim(role))` 강제. 저장 후 `'Researcher'` `'researcher '` 다 `'researcher'`로 통일.

**(2-B) 쿠 결정 영역 (form 비전과 무관, 구현 정합 detail)**

쿠가 구현하면서 결정. form 별도 결정 불필요.

- **인덱스 전략**: 단기 로드 쿼리 (`WHERE user_id=$1 AND created_at >= NOW() - INTERVAL '3 days'`) 빠르려면 `(user_id, created_at)` 복합 인덱스. + embedding은 HNSW (3072차원), p_tag/d_tag는 GIN array 인덱스. + role / is_pinned은 partial index.
- **Cold path 실패 처리**: tagging/embedding API 호출 실패 시 3회 retry → 그래도 실패면 `cold_error` 컬럼에 기록 + skip해서 다음 row 처리. 빈칸 그대로 두면 다음 스케줄러 사이클에서 재시도.
- **Cold path concurrency**: hot path INSERT와 cold path SELECT→UPDATE 충돌 방지 — `WHERE embedding IS NULL ORDER BY created_at LIMIT N FOR UPDATE SKIP LOCKED` 패턴.

**(3) 살릴 수 있는 현 코드 자산** (fresh impl 시작 시 유리)

처음부터 짜는 게 아니라 **wrong-axis 코드만 폐기 + 새 schema/Librarian/brief 새로 구현**.

- DB 연결 (pgvector 포함)
- SSH tunnel 설정
- MCP server 골격 (stdio, tool registration)
- subjects 테이블 (user 식별 / 자동 등록)
- embedding 호출부 (`generateEmbedding` 함수, 3-large로 모델만 교체)
- migration 시스템 (`migration_history` 추적)
- npx packaging 인프라 (esbuild 단일 번들)
- agent_platform / agent_model env 캡처 메커니즘 (v0.6.3+)
- ModelRegistry (`callRole` 추상화) — 새 librarian/tagger 호출에 재사용

**(4) 폐기할 wrong-axis 코드** (fresh impl 시작 시 제거)

- `librarian.ts`의 triage / extract / audit / fact_type 분류 path
- `memory_auditor.ts` (web grounding fact-check)
- `validator.ts` / scheduleValidation (사후 fact 검증)
- `subject_relationships` graph (별 axis)
- skills 시스템 (별 axis, 차후 재설계)
- `memories` 테이블의 fact_type / validation_status / 7-section brief 쿼리
- audit 관련 env (AUDIT_PROVIDER, AUDIT_MODEL 등 — TAG/EMBEDDING/CURATOR로 재구성)

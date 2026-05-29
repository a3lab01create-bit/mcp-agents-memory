/**
 * 一회성 라이브 검증 — clusterer(local llama.cpp Qwen3-14B)가
 * 어제 픽스(maxTokens 512→4096 + json_schema + thinking OFF) 이후
 * 실제로 valid JSON + multi-member 클러스터를 반환하는지 확인.
 *
 * DB는 읽기만 (top-50 d_tag 빈도). 쓰기/승급 없음 — 데몬·advisory lock 무관.
 * 실행: npx tsx scripts/verify_clusterer.ts
 */
import { db } from "../src/db.js";
import { getDefaultUserId } from "../src/users.js";
import { callRole } from "../src/model_registry.js";

const CLUSTER_SYSTEM = `You are a keyword clustering assistant for a personal memory system.

Given a list of d_tags (short hyphenated keywords) with their occurrence counts,
group semantically similar tags that refer to the same project or topic.

OUTPUT strict JSON object (NOT a bare array):
{ "clusters": [
  { "canonical": "<best-slug>", "members": ["<tag1>", "<tag2>", ...] }
] }

Rules:
- canonical must be one of the input tags (pick the most descriptive one) or a clean slug if none fit
- canonical must be lowercase, hyphenated (e.g. "yt-signal-finder")
- Only group tags that clearly refer to the same project/topic
- Tags with no similar counterparts become their own single-member cluster
- Do NOT merge unrelated topics just because they share one word`;

const CLUSTER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          canonical: { type: 'string' },
          members: { type: 'array', items: { type: 'string' } },
        },
        required: ['canonical', 'members'],
        additionalProperties: false,
      },
    },
  },
  required: ['clusters'],
  additionalProperties: false,
};

async function main() {
  const windowDays = Number(process.env.DTAG_PROMOTE_WINDOW_DAYS ?? 30);
  const userId = await getDefaultUserId();

  const freqResult = await db.query(
    `SELECT unnest(d_tag) AS tag, COUNT(*)::int AS cnt
       FROM memory
      WHERE user_id = $1 AND tag_processed = TRUE AND is_active = TRUE
        AND created_at >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY tag HAVING COUNT(*) >= 2
      ORDER BY cnt DESC LIMIT 50`,
    [userId, String(windowDays)]
  );

  const tags = freqResult.rows
    .map((r: any) => ({ tag: String(r.tag).toLowerCase().trim(), cnt: Number(r.cnt) }))
    .filter((t: any) => t.tag.length > 0);

  console.log(`\n[INPUT] ${tags.length} d_tags from DB (window ${windowDays}d):`);
  console.log(tags.map((t: any) => `${t.tag}(${t.cnt})`).join(", "));

  const tagList = tags.map((t: any) => `${t.tag} (${t.cnt}x)`).join(", ");
  const userPrompt = `Cluster these d_tags by project/topic:\n${tagList}`;

  const t0 = Date.now();
  let raw: string;
  try {
    raw = await callRole('clusterer', {
      system: CLUSTER_SYSTEM,
      user: userPrompt,
      jsonSchema: CLUSTER_SCHEMA,
      enableThinking: false,
      maxTokens: 4096,
    });
  } catch (err) {
    console.error(`\n[RESULT] ❌ clusterer call FAILED (connection/timeout):`, err);
    process.exit(2);
  }
  const ms = Date.now() - t0;

  console.log(`\n[RAW] ${raw.length} chars in ${ms}ms:`);
  console.log(raw.slice(0, 1200));

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`\n[RESULT] ❌ INVALID JSON (어제 픽스 회귀!) — parse failed`);
    process.exit(3);
  }

  const clusters = Array.isArray(parsed?.clusters) ? parsed.clusters : null;
  if (!clusters) {
    console.error(`\n[RESULT] ❌ valid JSON but no .clusters array`);
    process.exit(4);
  }

  const multi = clusters.filter((c: any) => Array.isArray(c.members) && c.members.length > 1);
  console.log(`\n[RESULT] ✅ valid JSON parsed`);
  console.log(`  total clusters : ${clusters.length}`);
  console.log(`  multi-member   : ${multi.length}  ${multi.length > 0 ? '← 진짜 클러스터링 작동' : '← (단일멤버뿐 — 묶을 게 없었거나 미작동)'}`);
  for (const c of multi.slice(0, 8)) {
    console.log(`    • ${c.canonical}: [${c.members.join(', ')}]`);
  }
  process.exit(0);
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });

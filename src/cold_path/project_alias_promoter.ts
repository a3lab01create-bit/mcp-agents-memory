/**
 * Project Alias Promoter — Stage 2 "noticing assistant".
 *
 * Finds canonical project tags that look like the same project, asks an
 * evidence-bound LLM judge, and stores high-confidence pending suggestions.
 * It never creates new embeddings and does not retag individual memories.
 */

import { db } from "../db.js";
import { callSpec, ROLE_REGISTRY } from "../model_registry.js";
import { getDefaultUserId } from "../users.js";
import { invalidateCandidateCache } from "./tagger.js";

type AliasRelation =
  | "rename"
  | "alias"
  | "same_project"
  | "different"
  | "misfile_suspected"
  | "insufficient";

type CandidateSource =
  | "explicit_user_statement"
  | "low_frequency_tag"
  | "vector_neighbor"
  | "d_tag_overlap"
  | "name_similarity";

type DecidedBy = "user" | "system";

interface TagInfo {
  id: number;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  memoryCount: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
  dTags: string[];
}

interface MemoryEvidence {
  id: number;
  role: "user" | "assistant";
  message: string;
  dTags: string[];
  createdAt: Date;
}

interface CandidatePair {
  sourceId: number;
  targetId: number;
  sources: Set<CandidateSource>;
  explicitStatements: MemoryEvidence[];
  score: number;
  signals: Record<string, unknown>;
}

interface AliasJudgment {
  relation: AliasRelation;
  same_project: boolean;
  source_should_alias_target: boolean;
  confidence: number;
  evidence_memory_ids: number[];
  conflict_memory_ids: number[];
  rationale: string;
}

export interface ProjectAliasPromoterSummary {
  userId: number;
  candidates: number;
  judged: number;
  inserted: number;
  autoApplied: number;
  skipped: number;
  errors: number;
}

export interface ApplyAliasResult {
  suggestionId: number;
  applied: boolean;
  status?: string;
  reason?: string;
}

const QUALIFYING_RELATIONS = new Set<AliasRelation>([
  "rename",
  "alias",
  "same_project",
]);

const PROJECT_ALIAS_PROMOTER_DEFAULT_INTERVAL_HOURS = 24;

const ALL_RELATIONS = new Set<AliasRelation>([
  "rename",
  "alias",
  "same_project",
  "different",
  "misfile_suspected",
  "insufficient",
]);

const EXPLICIT_PATTERNS = [
  "%이름 바꿈%",
  "%이름바꿈%",
  "%이름을 바꿈%",
  "%개명%",
  "%이제%로%",
  "%같은 프로젝트%",
  "%동일%",
  "%합쳐%",
  "%합치%",
  "%별칭%",
  "%동의어%",
  "%rename%",
  "%renamed%",
  "%now called%",
  "%same as%",
  "%alias%",
];

let projectAliasPromoterRunning = false;

const SOURCE_WEIGHT: Record<CandidateSource, number> = {
  explicit_user_statement: 100,
  vector_neighbor: 30,
  d_tag_overlap: 18,
  name_similarity: 16,
  low_frequency_tag: 8,
};

/** JSON Schema for project_alias_judge output — used with local llama.cpp to enforce grammar (no <think> bleed).
 *  Note: confidence has no minimum/maximum — llama.cpp grammar cannot enforce numeric ranges;
 *  the parser clamps via clamp01() already.
 */
const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    relation: { type: 'string', enum: ['rename', 'alias', 'same_project', 'different', 'misfile_suspected', 'insufficient'] },
    same_project: { type: 'boolean' },
    source_should_alias_target: { type: 'boolean' },
    confidence: { type: 'number' },
    evidence_memory_ids: { type: 'array', items: { type: 'integer' } },
    conflict_memory_ids: { type: 'array', items: { type: 'integer' } },
    rationale: { type: 'string' },
  },
  required: ['relation', 'same_project', 'source_should_alias_target', 'confidence', 'evidence_memory_ids', 'conflict_memory_ids', 'rationale'],
  additionalProperties: false,
};

const JUDGE_SYSTEM_PROMPT = `You are a project-tag alias judge for one user's personal memory system.

Decide whether two CANONICAL project tags refer to the same project identity.

OUTPUT strict JSON only:
{
  "relation": "rename" | "alias" | "same_project" | "different" | "misfile_suspected" | "insufficient",
  "same_project": true | false,
  "source_should_alias_target": true | false,
  "confidence": 0.0,
  "evidence_memory_ids": [],
  "conflict_memory_ids": [],
  "rationale": ""
}

Rules:
- "Related" is not the same as "same project". Shared topic, tech stack, or client is not enough.
- Vector similarity is recall evidence only. Never conclude same_project from vector similarity alone.
- A colloquial nickname, renamed label, Korean/English spelling variant, or old/new project name can be alias/rename.
- If only a few memories are filed under the wrong tag, relation must be "misfile_suspected"; do not recommend aliasing the whole tag.
- If same_project is true, choose direction. source_should_alias_target=true means Tag A should alias Tag B. false means Tag B should alias Tag A.
- If direction is unclear, use relation="insufficient" or lower confidence.
- evidence_memory_ids and conflict_memory_ids must only use supplied memory ids.`;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return toDate(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map((v) => String(v).trim())
    .filter(Boolean);
}

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function tokenSet(name: string): Set<string> {
  return new Set(normalizeText(name).split(" ").filter((t) => t.length > 0));
}

function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection++;
  }
  return intersection / (left.size + right.size - intersection);
}

function bigramDice(a: string, b: string): number {
  const left = compactText(a);
  const right = compactText(b);
  if (left.length < 3 || right.length < 3) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.78;

  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };

  const g1 = grams(left);
  const g2 = grams(right);
  let overlap = 0;
  for (const [g, count] of g1) {
    overlap += Math.min(count, g2.get(g) ?? 0);
  }
  return (2 * overlap) / Math.max(1, left.length + right.length - 2);
}

function nameSimilarity(a: string, b: string): number {
  const tokenScore = jaccard(tokenSet(a), tokenSet(b));
  const dice = bigramDice(a, b);
  return Math.max(tokenScore, dice);
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function uniqueSortedNumbers(values: Iterable<number>): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function tagPayload(tag: TagInfo): Record<string, unknown> {
  return {
    id: tag.id,
    name: tag.name,
    description: tag.description,
    memory_count: tag.memoryCount,
    first_seen: tag.firstSeen?.toISOString() ?? null,
    last_seen: tag.lastSeen?.toISOString() ?? null,
    d_tags: tag.dTags.slice(0, 20),
  };
}

function isNewOrLowFrequency(tag: TagInfo): boolean {
  const lowMax = envInt("PROJECT_ALIAS_LOW_COUNT_MAX", 3);
  const newDays = envInt("PROJECT_ALIAS_NEW_TAG_DAYS", 14);
  const ageMs = Date.now() - tag.createdAt.getTime();
  return tag.memoryCount <= lowMax || ageMs <= newDays * 24 * 60 * 60 * 1000;
}

function chooseDirection(a: TagInfo, b: TagInfo): { sourceId: number; targetId: number } {
  if (a.memoryCount !== b.memoryCount) {
    return a.memoryCount < b.memoryCount
      ? { sourceId: a.id, targetId: b.id }
      : { sourceId: b.id, targetId: a.id };
  }

  const aFirst = a.firstSeen?.getTime() ?? a.createdAt.getTime();
  const bFirst = b.firstSeen?.getTime() ?? b.createdAt.getTime();
  if (aFirst !== bFirst) {
    return aFirst > bFirst
      ? { sourceId: a.id, targetId: b.id }
      : { sourceId: b.id, targetId: a.id };
  }

  return a.id > b.id
    ? { sourceId: a.id, targetId: b.id }
    : { sourceId: b.id, targetId: a.id };
}

function getOrAddPair(
  pairs: Map<string, CandidatePair>,
  tagsById: Map<number, TagInfo>,
  aId: number,
  bId: number
): CandidatePair | null {
  if (aId === bId) return null;
  const a = tagsById.get(aId);
  const b = tagsById.get(bId);
  if (!a || !b) return null;

  const key = pairKey(aId, bId);
  const existing = pairs.get(key);
  if (existing) return existing;

  const direction = chooseDirection(a, b);
  const pair: CandidatePair = {
    sourceId: direction.sourceId,
    targetId: direction.targetId,
    sources: new Set<CandidateSource>(),
    explicitStatements: [],
    score: 0,
    signals: {},
  };
  pairs.set(key, pair);
  return pair;
}

function addSource(pair: CandidatePair, source: CandidateSource): void {
  if (!pair.sources.has(source)) {
    pair.sources.add(source);
    pair.score += SOURCE_WEIGHT[source];
  }
}

function addExplicitStatement(pair: CandidatePair, memory: MemoryEvidence): void {
  addSource(pair, "explicit_user_statement");
  if (!pair.explicitStatements.some((m) => m.id === memory.id)) {
    pair.explicitStatements.push(memory);
  }
  pair.signals.explicit_statement_ids = pair.explicitStatements.map((m) => m.id);
  pair.signals.explicit_statement_previews = pair.explicitStatements.map((m) => ({
    id: m.id,
    preview: truncate(m.message, 240),
  }));
}

function addLowFrequencySignal(pair: CandidatePair, tagId: number): void {
  addSource(pair, "low_frequency_tag");
  const current = toNumberArray(pair.signals.low_frequency_anchor_ids);
  pair.signals.low_frequency_anchor_ids = uniqueSortedNumbers([...current, tagId]);
}

function messageMentionsTag(message: string, tag: TagInfo): boolean {
  const lowerMessage = message.toLowerCase();
  const lowerName = tag.name.toLowerCase();
  if (lowerName.length >= 3 && lowerMessage.includes(lowerName)) return true;

  const normalizedName = normalizeText(tag.name);
  const normalizedMessage = normalizeText(message);
  if (normalizedName.length >= 3 && normalizedMessage.includes(normalizedName)) return true;

  const compactName = compactText(tag.name);
  const compactMessage = compactText(message);
  return compactName.length >= 3 && compactMessage.includes(compactName);
}

async function listCanonicalTags(userId: number): Promise<TagInfo[]> {
  const maxTags = envInt("PROJECT_ALIAS_MAX_TAGS", 120);
  const result = await db.query(
    `SELECT pt.id,
            pt.name,
            pt.description,
            pt.created_at,
            pt.updated_at,
            COUNT(m.id)::int AS memory_count,
            MIN(m.created_at) AS first_seen,
            MAX(m.created_at) AS last_seen
       FROM project_tags pt
       LEFT JOIN memory m
         ON m.user_id = $1
        AND m.is_active = TRUE
        AND m.p_tag_id IS NOT NULL
        AND canonical_project_tag_id(m.p_tag_id) = pt.id
      WHERE pt.alias_of IS NULL
      GROUP BY pt.id
      ORDER BY MAX(m.created_at) DESC NULLS LAST, pt.created_at DESC
      LIMIT $2`,
    [userId, maxTags]
  );

  const tags: TagInfo[] = result.rows.map((row: any) => ({
    id: Number(row.id),
    name: String(row.name),
    description: row.description === null ? null : String(row.description),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    memoryCount: Number(row.memory_count ?? 0),
    firstSeen: toNullableDate(row.first_seen),
    lastSeen: toNullableDate(row.last_seen),
    dTags: [],
  }));

  if (tags.length === 0) return tags;

  const tagIds = tags.map((t) => t.id);
  const dtagResult = await db.query(
    `SELECT tag_id, ARRAY_AGG(DISTINCT tag ORDER BY tag) AS d_tags
       FROM (
         SELECT canonical_project_tag_id(m.p_tag_id) AS tag_id,
                dt.tag AS tag
           FROM memory m
           CROSS JOIN LATERAL unnest(m.d_tag) AS dt(tag)
          WHERE m.user_id = $1
            AND m.is_active = TRUE
            AND m.p_tag_id IS NOT NULL
            AND canonical_project_tag_id(m.p_tag_id) = ANY($2::bigint[])
            AND dt.tag <> ''
       ) s
      GROUP BY tag_id`,
    [userId, tagIds]
  );

  const dTagsById = new Map<number, string[]>();
  for (const row of dtagResult.rows) {
    dTagsById.set(Number(row.tag_id), toStringArray(row.d_tags));
  }

  for (const tag of tags) {
    tag.dTags = dTagsById.get(tag.id) ?? [];
  }

  return tags;
}

async function listRepresentativeMemories(
  userId: number,
  tagIds: number[],
  perTag = 3
): Promise<Map<number, MemoryEvidence[]>> {
  const out = new Map<number, MemoryEvidence[]>();
  if (tagIds.length === 0) return out;

  const result = await db.query(
    `WITH ranked AS (
       SELECT canonical_project_tag_id(m.p_tag_id) AS tag_id,
              m.id,
              m.role,
              m.message,
              m.d_tag,
              m.created_at,
              ROW_NUMBER() OVER (
                PARTITION BY canonical_project_tag_id(m.p_tag_id)
                ORDER BY m.is_pinned DESC, m.created_at DESC
              ) AS rn
         FROM memory m
        WHERE m.user_id = $1
          AND m.is_active = TRUE
          AND m.p_tag_id IS NOT NULL
          AND canonical_project_tag_id(m.p_tag_id) = ANY($2::bigint[])
     )
     SELECT tag_id, id, role, message, d_tag, created_at
       FROM ranked
      WHERE rn <= $3
      ORDER BY tag_id, rn`,
    [userId, tagIds, perTag]
  );

  for (const row of result.rows) {
    const tagId = Number(row.tag_id);
    const list = out.get(tagId) ?? [];
    list.push({
      id: Number(row.id),
      role: row.role === "assistant" ? "assistant" : "user",
      message: String(row.message),
      dTags: toStringArray(row.d_tag),
      createdAt: toDate(row.created_at),
    });
    out.set(tagId, list);
  }

  return out;
}

async function addExplicitStatementCandidates(
  userId: number,
  tags: TagInfo[],
  tagsById: Map<number, TagInfo>,
  pairs: Map<string, CandidatePair>
): Promise<void> {
  const scanLimit = envInt("PROJECT_ALIAS_EXPLICIT_SCAN_LIMIT", 200);
  const clauses = EXPLICIT_PATTERNS.map((_, i) => `message ILIKE $${i + 2}`).join(" OR ");
  const limitParam = EXPLICIT_PATTERNS.length + 2;
  const result = await db.query(
    `SELECT id,
            message,
            d_tag,
            created_at,
            canonical_project_tag_id(p_tag_id) AS memory_tag_id
       FROM memory
      WHERE user_id = $1
        AND role = 'user'
        AND is_active = TRUE
        AND (${clauses})
      ORDER BY created_at DESC
      LIMIT $${limitParam}`,
    [userId, ...EXPLICIT_PATTERNS, scanLimit]
  );

  for (const row of result.rows) {
    const memory: MemoryEvidence = {
      id: Number(row.id),
      role: "user",
      message: String(row.message),
      dTags: toStringArray(row.d_tag),
      createdAt: toDate(row.created_at),
    };

    const mentioned = new Set<number>();
    for (const tag of tags) {
      if (messageMentionsTag(memory.message, tag)) {
        mentioned.add(tag.id);
      }
    }
    const memoryTagId = row.memory_tag_id === null ? null : Number(row.memory_tag_id);
    if (memoryTagId && tagsById.has(memoryTagId)) {
      mentioned.add(memoryTagId);
    }

    const ids = Array.from(mentioned);
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pair = getOrAddPair(pairs, tagsById, ids[i], ids[j]);
        if (pair) addExplicitStatement(pair, memory);
      }
    }
  }
}

function addNameAndDtagCandidates(
  tags: TagInfo[],
  tagsById: Map<number, TagInfo>,
  pairs: Map<string, CandidatePair>
): void {
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i];
      const b = tags[j];
      const lowAnchor = isNewOrLowFrequency(a) || isNewOrLowFrequency(b);
      const nScore = nameSimilarity(a.name, b.name);
      const dScore = jaccard(a.dTags, b.dTags);

      const nameThreshold = lowAnchor ? 0.45 : 0.55;
      const dtagThreshold = lowAnchor ? 0.18 : 0.25;

      if (nScore >= nameThreshold) {
        const pair = getOrAddPair(pairs, tagsById, a.id, b.id);
        if (pair) {
          addSource(pair, "name_similarity");
          pair.signals.name_similarity = Math.max(
            Number(pair.signals.name_similarity ?? 0),
            Number(nScore.toFixed(4))
          );
          if (isNewOrLowFrequency(a)) addLowFrequencySignal(pair, a.id);
          if (isNewOrLowFrequency(b)) addLowFrequencySignal(pair, b.id);
        }
      }

      if (dScore >= dtagThreshold) {
        const pair = getOrAddPair(pairs, tagsById, a.id, b.id);
        if (pair) {
          addSource(pair, "d_tag_overlap");
          pair.signals.d_tag_jaccard = Math.max(
            Number(pair.signals.d_tag_jaccard ?? 0),
            Number(dScore.toFixed(4))
          );
          pair.signals.shared_d_tags = a.dTags.filter((t) => b.dTags.includes(t)).slice(0, 20);
          if (isNewOrLowFrequency(a)) addLowFrequencySignal(pair, a.id);
          if (isNewOrLowFrequency(b)) addLowFrequencySignal(pair, b.id);
        }
      }
    }
  }
}

async function addVectorCandidates(
  userId: number,
  tags: TagInfo[],
  tagsById: Map<number, TagInfo>,
  pairs: Map<string, CandidatePair>
): Promise<void> {
  const anchorLimit = envInt("PROJECT_ALIAS_VECTOR_ANCHOR_LIMIT", 12);
  const representativeLimit = envInt("PROJECT_ALIAS_VECTOR_REPRESENTATIVE_LIMIT", 5);
  const perMemoryLimit = envInt("PROJECT_ALIAS_VECTOR_PER_MEMORY_LIMIT", 8);
  const perTagLimit = envInt("PROJECT_ALIAS_VECTOR_TARGET_LIMIT", 3);
  const maxDistance = envFloat("PROJECT_ALIAS_VECTOR_MAX_DISTANCE", 0.28);

  const anchors = tags
    .slice()
    .sort((a, b) => {
      const aLow = isNewOrLowFrequency(a) ? 1 : 0;
      const bLow = isNewOrLowFrequency(b) ? 1 : 0;
      if (aLow !== bLow) return bLow - aLow;
      return (b.lastSeen?.getTime() ?? b.createdAt.getTime()) - (a.lastSeen?.getTime() ?? a.createdAt.getTime());
    })
    .slice(0, anchorLimit);

  for (const anchor of anchors) {
    const result = await db.query(
      `WITH src AS (
         SELECT id, embedding
           FROM memory
          WHERE user_id = $1
            AND is_active = TRUE
            AND p_tag_id IS NOT NULL
            AND embedding IS NOT NULL
            AND canonical_project_tag_id(p_tag_id) = $2
          ORDER BY is_pinned DESC, created_at DESC
          LIMIT $3
       ),
       neighbors AS (
         SELECT canonical_project_tag_id(m.p_tag_id) AS target_tag_id,
                m.id AS memory_id,
                src.id AS source_memory_id,
                (m.embedding <=> src.embedding) AS distance
           FROM src
           JOIN LATERAL (
             SELECT id, p_tag_id, embedding
               FROM memory
              WHERE user_id = $1
                AND is_active = TRUE
                AND p_tag_id IS NOT NULL
                AND embedding IS NOT NULL
                AND canonical_project_tag_id(p_tag_id) <> $2
              ORDER BY embedding <=> src.embedding
              LIMIT $4
           ) m ON TRUE
       )
       SELECT target_tag_id,
              MIN(distance)::float8 AS min_distance,
              (ARRAY_AGG(memory_id ORDER BY distance))[1:5] AS evidence_memory_ids,
              (ARRAY_AGG(source_memory_id ORDER BY distance))[1:5] AS source_memory_ids
         FROM neighbors
        WHERE target_tag_id IS NOT NULL
        GROUP BY target_tag_id
       HAVING MIN(distance) <= $5
        ORDER BY MIN(distance)
        LIMIT $6`,
      [userId, anchor.id, representativeLimit, perMemoryLimit, maxDistance, perTagLimit]
    );

    for (const row of result.rows) {
      const targetId = Number(row.target_tag_id);
      if (!tagsById.has(targetId)) continue;
      const pair = getOrAddPair(pairs, tagsById, anchor.id, targetId);
      if (!pair) continue;

      addSource(pair, "vector_neighbor");
      if (isNewOrLowFrequency(anchor)) addLowFrequencySignal(pair, anchor.id);

      const vectorSignals = Array.isArray(pair.signals.vector_neighbors)
        ? pair.signals.vector_neighbors
        : [];
      vectorSignals.push({
        source_tag_id: anchor.id,
        target_tag_id: targetId,
        min_distance: Number(Number(row.min_distance).toFixed(6)),
        evidence_memory_ids: toNumberArray(row.evidence_memory_ids),
        source_memory_ids: toNumberArray(row.source_memory_ids),
      });
      pair.signals.vector_neighbors = vectorSignals;
      const previous = Number(pair.signals.vector_min_distance ?? Number.POSITIVE_INFINITY);
      pair.signals.vector_min_distance = Math.min(previous, Number(row.min_distance));
    }
  }
}

async function buildCandidatePairs(
  userId: number,
  tags: TagInfo[],
  limit: number
): Promise<CandidatePair[]> {
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
  const pairs = new Map<string, CandidatePair>();

  await addExplicitStatementCandidates(userId, tags, tagsById, pairs);
  addNameAndDtagCandidates(tags, tagsById, pairs);
  await addVectorCandidates(userId, tags, tagsById, pairs);

  for (const pair of pairs.values()) {
    const source = tagsById.get(pair.sourceId);
    const target = tagsById.get(pair.targetId);
    if (source && target) {
      pair.signals.source_tag = tagPayload(source);
      pair.signals.target_tag = tagPayload(target);
      pair.signals.candidate_sources = Array.from(pair.sources);
    }
  }

  return Array.from(pairs.values())
    .sort((a, b) => {
      const aExplicit = a.sources.has("explicit_user_statement") ? 1 : 0;
      const bExplicit = b.sources.has("explicit_user_statement") ? 1 : 0;
      if (aExplicit !== bExplicit) return bExplicit - aExplicit;
      return b.score - a.score;
    })
    .slice(0, limit);
}

function formatMemoryForPrompt(memory: MemoryEvidence): Record<string, unknown> {
  return {
    id: memory.id,
    role: memory.role,
    created_at: memory.createdAt.toISOString(),
    d_tags: memory.dTags.slice(0, 8),
    message: truncate(memory.message, 700),
  };
}

function collectAllowedMemoryIds(
  pair: CandidatePair,
  sourceMemories: MemoryEvidence[],
  targetMemories: MemoryEvidence[]
): Set<number> {
  return new Set([
    ...pair.explicitStatements.map((m) => m.id),
    ...sourceMemories.map((m) => m.id),
    ...targetMemories.map((m) => m.id),
  ]);
}

function parseJsonObject(raw: string): unknown {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```json|```/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error(`invalid JSON: ${cleaned.slice(0, 240)}`);
  }
}

function normalizeJudgment(raw: string, allowedIds: Set<number>): AliasJudgment {
  const parsed = parseJsonObject(raw) as Record<string, unknown>;
  let relation = String(parsed.relation ?? "insufficient").trim() as AliasRelation;
  if (!ALL_RELATIONS.has(relation)) relation = "insufficient";

  const directionIsBoolean = typeof parsed.source_should_alias_target === "boolean";
  if (QUALIFYING_RELATIONS.has(relation) && !directionIsBoolean) {
    relation = "insufficient";
  }

  const evidence = toNumberArray(parsed.evidence_memory_ids).filter((id) => allowedIds.has(id));
  const conflicts = toNumberArray(parsed.conflict_memory_ids).filter((id) => allowedIds.has(id));
  const confidence = clamp01(Number(parsed.confidence ?? 0));
  const sameProject =
    typeof parsed.same_project === "boolean"
      ? parsed.same_project
      : QUALIFYING_RELATIONS.has(relation);

  return {
    relation,
    same_project: sameProject,
    source_should_alias_target: directionIsBoolean
      ? Boolean(parsed.source_should_alias_target)
      : true,
    confidence,
    evidence_memory_ids: evidence,
    conflict_memory_ids: conflicts,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
  };
}

async function judgePair(
  pair: CandidatePair,
  tagsById: Map<number, TagInfo>,
  memoriesByTag: Map<number, MemoryEvidence[]>
): Promise<AliasJudgment> {
  const source = tagsById.get(pair.sourceId);
  const target = tagsById.get(pair.targetId);
  if (!source || !target) {
    throw new Error("candidate pair references missing tag");
  }

  const sourceMemories = memoriesByTag.get(source.id) ?? [];
  const targetMemories = memoriesByTag.get(target.id) ?? [];
  const allowedIds = collectAllowedMemoryIds(pair, sourceMemories, targetMemories);

  // Prompt-only signals copy: drop explicit_statement_previews because the same explicit
  // statements are already serialized in full below as explicit_user_statements. Keeping
  // both double-counted the identical content and overflowed ctx 8192 on heavily-discussed
  // tag pairs (8245/9766 tokens). The DB upsert (upsertSuggestion) still stores the full
  // signals for debugging — only the LLM prompt is slimmed.
  const promptSignals = { ...pair.signals };
  delete promptSignals.explicit_statement_previews;

  // Cap explicit statements fed to the judge. addExplicitStatement is uncapped (pushes every
  // pattern match), and rows arrive created_at DESC, so slice the most-recent N. A judge needs
  // only a few clear statements; uncapped accumulation was the primary ctx-8192 overflow.
  const explicitPromptCap = envInt("PROJECT_ALIAS_EXPLICIT_PROMPT_CAP", 5);

  const userPrompt = JSON.stringify(
    {
      task: "Judge whether Tag A and Tag B are the same project identity.",
      candidate_sources: Array.from(pair.sources),
      signals: promptSignals,
      tag_a_source_candidate: tagPayload(source),
      tag_b_target_candidate: tagPayload(target),
      tag_a_representative_memories: sourceMemories.map(formatMemoryForPrompt),
      tag_b_representative_memories: targetMemories.map(formatMemoryForPrompt),
      explicit_user_statements: pair.explicitStatements
        .slice(0, explicitPromptCap)
        .map(formatMemoryForPrompt),
    },
    null,
    2
  );

  const spec = ROLE_REGISTRY.project_alias_judge;
  const raw = await callSpec(spec, {
    system: JUDGE_SYSTEM_PROMPT,
    user: userPrompt,
    ...(spec.provider === "local"
      ? { jsonSchema: JUDGE_SCHEMA, enableThinking: false }
      : { responseFormat: "json" as const }),
    maxTokens: envInt("PROJECT_ALIAS_JUDGE_MAX_TOKENS", 8192),
  });
  if (!raw) throw new Error("project_alias_judge returned empty content");

  return normalizeJudgment(raw, allowedIds);
}

async function areCanonicalRoots(tagIds: number[]): Promise<boolean> {
  if (tagIds.length === 0) return false;
  const result = await db.query(
    `SELECT id, alias_of
       FROM project_tags
      WHERE id = ANY($1::bigint[])`,
    [tagIds]
  );
  if (result.rows.length !== tagIds.length) return false;
  return result.rows.every((row: any) => row.alias_of === null);
}

async function hasRecentRejectedPair(userId: number, sourceId: number, targetId: number): Promise<boolean> {
  const rejectWindowDays = envInt("PROJECT_ALIAS_REJECT_WINDOW_DAYS", 30);
  const result = await db.query(
    `SELECT 1
       FROM project_tag_alias_suggestions
      WHERE user_id = $1
        AND status = 'rejected'
        AND LEAST(source_tag_id, target_tag_id) = LEAST($2::bigint, $3::bigint)
        AND GREATEST(source_tag_id, target_tag_id) = GREATEST($2::bigint, $3::bigint)
        AND COALESCE(decided_at, updated_at, created_at) >= NOW() - ($4 || ' days')::interval
      LIMIT 1`,
    [userId, sourceId, targetId, String(rejectWindowDays)]
  );
  return result.rows.length > 0;
}

async function computeAutoApplyEligible(
  userId: number,
  sourceId: number,
  targetId: number,
  pair: CandidatePair,
  judgment: AliasJudgment
): Promise<boolean> {
  if (!pair.sources.has("explicit_user_statement")) return false;
  if (!QUALIFYING_RELATIONS.has(judgment.relation)) return false;
  if (!judgment.same_project) return false;
  if (judgment.confidence < 0.98) return false;
  if (judgment.conflict_memory_ids.length > 0) return false;
  if (!(await areCanonicalRoots([sourceId, targetId]))) return false;
  if (await hasRecentRejectedPair(userId, sourceId, targetId)) return false;
  return true;
}

async function upsertSuggestion(
  userId: number,
  sourceId: number,
  targetId: number,
  pair: CandidatePair,
  judgment: AliasJudgment,
  autoApplyEligible: boolean
): Promise<number> {
  const spec = ROLE_REGISTRY.project_alias_judge;
  const candidateSources = Array.from(pair.sources);
  const signals = {
    ...pair.signals,
    llm: {
      relation: judgment.relation,
      same_project: judgment.same_project,
      source_should_alias_target: judgment.source_should_alias_target,
      stored_source_tag_id: sourceId,
      stored_target_tag_id: targetId,
      direction_reversed_from_candidate: sourceId !== pair.sourceId || targetId !== pair.targetId,
    },
  };

  const result = await db.query(
    `INSERT INTO project_tag_alias_suggestions (
       user_id,
       source_tag_id,
       target_tag_id,
       relation,
       status,
       confidence,
       candidate_sources,
       evidence_memory_ids,
       conflict_memory_ids,
       signals,
       model_provider,
       model_name,
       rationale,
       auto_apply_eligible
     )
     VALUES (
       $1, $2, $3, $4, 'pending', $5,
       $6::text[], $7::bigint[], $8::bigint[], $9::jsonb,
       $10, $11, $12, $13
     )
     ON CONFLICT (
       user_id,
       (LEAST(source_tag_id, target_tag_id)),
       (GREATEST(source_tag_id, target_tag_id))
     )
     WHERE status = 'pending'
     DO UPDATE SET
       source_tag_id = EXCLUDED.source_tag_id,
       target_tag_id = EXCLUDED.target_tag_id,
       relation = EXCLUDED.relation,
       confidence = EXCLUDED.confidence,
       candidate_sources = EXCLUDED.candidate_sources,
       evidence_memory_ids = EXCLUDED.evidence_memory_ids,
       conflict_memory_ids = EXCLUDED.conflict_memory_ids,
       signals = EXCLUDED.signals,
       model_provider = EXCLUDED.model_provider,
       model_name = EXCLUDED.model_name,
       rationale = EXCLUDED.rationale,
       auto_apply_eligible = EXCLUDED.auto_apply_eligible,
       updated_at = NOW()
     RETURNING id`,
    [
      userId,
      sourceId,
      targetId,
      judgment.relation,
      Number(judgment.confidence.toFixed(4)),
      candidateSources,
      judgment.evidence_memory_ids,
      judgment.conflict_memory_ids,
      JSON.stringify(signals),
      spec.provider,
      spec.model_name,
      truncate(judgment.rationale, 4000),
      autoApplyEligible,
    ]
  );

  return Number(result.rows[0].id);
}

function qualifiesForPending(judgment: AliasJudgment, minConfidence: number): boolean {
  return (
    QUALIFYING_RELATIONS.has(judgment.relation) &&
    judgment.same_project &&
    judgment.confidence >= minConfidence
  );
}

export async function runProjectAliasPromoter(
  opts: { userId?: number; limit?: number } = {}
): Promise<ProjectAliasPromoterSummary> {
  const userId = opts.userId ?? (await getDefaultUserId());
  const candidateLimit = opts.limit ?? envInt("PROJECT_ALIAS_CANDIDATE_LIMIT", 12);
  const pendingMin = envFloat("PROJECT_ALIAS_PENDING_MIN", 0.85);

  const summary: ProjectAliasPromoterSummary = {
    userId,
    candidates: 0,
    judged: 0,
    inserted: 0,
    autoApplied: 0,
    skipped: 0,
    errors: 0,
  };

  const tags = await listCanonicalTags(userId);
  if (tags.length < 2) return summary;

  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
  const pairs = await buildCandidatePairs(userId, tags, candidateLimit);
  summary.candidates = pairs.length;
  if (pairs.length === 0) return summary;

  const tagIdsForPrompt = uniqueSortedNumbers(
    pairs.flatMap((pair) => [pair.sourceId, pair.targetId])
  );
  const memoriesByTag = await listRepresentativeMemories(userId, tagIdsForPrompt, 3);

  for (const pair of pairs) {
    try {
      const judgment = await judgePair(pair, tagsById, memoriesByTag);
      summary.judged++;

      if (!qualifiesForPending(judgment, pendingMin)) {
        summary.skipped++;
        continue;
      }

      let sourceId = pair.sourceId;
      let targetId = pair.targetId;
      if (!judgment.source_should_alias_target) {
        sourceId = pair.targetId;
        targetId = pair.sourceId;
      }

      if (sourceId === targetId) {
        summary.skipped++;
        continue;
      }

      const autoApplyEligible = await computeAutoApplyEligible(
        userId,
        sourceId,
        targetId,
        pair,
        judgment
      );
      const suggestionId = await upsertSuggestion(
        userId,
        sourceId,
        targetId,
        pair,
        judgment,
        autoApplyEligible
      );
      summary.inserted++;

      if (process.env.PROJECT_ALIAS_AUTO_APPLY === "true" && autoApplyEligible) {
        const applied = await applyAliasSuggestion(suggestionId, {
          decidedBy: "system",
          reason: "auto-apply eligible: explicit user rename/alias statement and high-confidence judge result",
        });
        if (applied.applied) summary.autoApplied++;
      }
    } catch (err) {
      summary.errors++;
      console.error("[ProjectAliasPromoter] pair failed:", err);
    }
  }

  return summary;
}

export async function maybeRunProjectAliasPromoter(): Promise<void> {
  if (process.env.PROJECT_ALIAS_PROMOTER_ENABLED !== "true") return;
  if (projectAliasPromoterRunning) return;

  projectAliasPromoterRunning = true;
  const intervalHours = envInt(
    "PROJECT_ALIAS_PROMOTER_INTERVAL_HOURS",
    PROJECT_ALIAS_PROMOTER_DEFAULT_INTERVAL_HOURS
  );

  try {
    const userId = await getDefaultUserId();
    const result = await db.query(
      `SELECT project_alias_promoter_last_run_at
         FROM users
        WHERE user_id = $1`,
      [userId]
    );

    const lastRunAt: Date | null =
      result.rows[0]?.project_alias_promoter_last_run_at ?? null;
    const cooldownMs = intervalHours * 60 * 60 * 1000;
    const cooldownPassed =
      lastRunAt === null ||
      Date.now() - new Date(lastRunAt).getTime() >= cooldownMs;
    if (!cooldownPassed) return;

    // 시도 시 즉시 last_run_at 업데이트 — 실패해도 interval 쿨다운으로 hammer 방지.
    await db.query(
      `UPDATE users
          SET project_alias_promoter_last_run_at = NOW()
        WHERE user_id = $1`,
      [userId]
    );

    const summary = await runProjectAliasPromoter({ userId });
    if (summary.candidates > 0 || summary.inserted > 0 || summary.errors > 0) {
      console.error(
        `🔁 [ProjectAliasPromoter] done — candidates=${summary.candidates}, judged=${summary.judged}, inserted=${summary.inserted}, autoApplied=${summary.autoApplied}, skipped=${summary.skipped}, errors=${summary.errors}`
      );
    }
  } catch (err) {
    console.error(
      `⚠️ [ProjectAliasPromoter] run failed (retries in ${intervalHours}h):`,
      err
    );
  } finally {
    projectAliasPromoterRunning = false;
  }
}

async function markSuggestionTerminal(
  client: any,
  suggestionId: number,
  status: "rejected" | "superseded",
  decidedBy: DecidedBy,
  reason: string
): Promise<void> {
  await client.query(
    `UPDATE project_tag_alias_suggestions
        SET status = $2,
            decided_by = $3,
            decision_reason = $4,
            decided_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [suggestionId, status, decidedBy, reason]
  );
}

async function targetChainContainsSource(client: any, sourceId: number, targetId: number): Promise<boolean> {
  const result = await client.query(
    `WITH RECURSIVE chain(id, alias_of, path) AS (
       SELECT id, alias_of, ARRAY[id]::bigint[]
         FROM project_tags
        WHERE id = $2
       UNION ALL
       SELECT pt.id, pt.alias_of, chain.path || pt.id
         FROM project_tags pt
         JOIN chain ON pt.id = chain.alias_of
        WHERE NOT pt.id = ANY(chain.path)
     )
     SELECT 1
       FROM chain
      WHERE id = $1
      LIMIT 1`,
    [sourceId, targetId]
  );
  return result.rows.length > 0;
}

export async function applyAliasSuggestion(
  suggestionId: number,
  opts: { decidedBy?: DecidedBy; reason?: string } = {}
): Promise<ApplyAliasResult> {
  const decidedBy = opts.decidedBy ?? "system";
  const reason = opts.reason ?? (decidedBy === "user" ? "confirmed by user" : "auto-applied by system");
  const appliedStatus = decidedBy === "system" ? "auto_applied" : "confirmed";

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const suggestionResult = await client.query(
      `SELECT *
         FROM project_tag_alias_suggestions
        WHERE id = $1
        FOR UPDATE`,
      [suggestionId]
    );

    if (suggestionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { suggestionId, applied: false, reason: "suggestion_not_found" };
    }

    const suggestion = suggestionResult.rows[0];
    if (suggestion.status !== "pending") {
      await client.query("ROLLBACK");
      return {
        suggestionId,
        applied: false,
        status: String(suggestion.status),
        reason: "already_decided",
      };
    }

    const sourceId = Number(suggestion.source_tag_id);
    const targetId = Number(suggestion.target_tag_id);

    const roots = await client.query(
      `SELECT canonical_project_tag_id($1::bigint) AS source_root,
              canonical_project_tag_id($2::bigint) AS target_root`,
      [sourceId, targetId]
    );
    const sourceRoot = Number(roots.rows[0]?.source_root);
    const targetRoot = Number(roots.rows[0]?.target_root);

    await client.query(
      `SELECT id
         FROM project_tags
        WHERE id = ANY($1::bigint[])
        FOR UPDATE`,
      [[sourceId, targetRoot]]
    );

    if (!Number.isInteger(sourceRoot) || sourceRoot !== sourceId) {
      const msg = "source tag is no longer a canonical root";
      await markSuggestionTerminal(client, suggestionId, "superseded", "system", msg);
      await client.query("COMMIT");
      return { suggestionId, applied: false, status: "superseded", reason: msg };
    }

    if (!Number.isInteger(targetRoot) || targetRoot === sourceId) {
      const msg = "alias would point source to itself";
      await markSuggestionTerminal(client, suggestionId, "rejected", decidedBy, msg);
      await client.query("COMMIT");
      return { suggestionId, applied: false, status: "rejected", reason: msg };
    }

    if (await targetChainContainsSource(client, sourceId, targetId)) {
      const msg = "alias would create a project_tag alias cycle";
      await markSuggestionTerminal(client, suggestionId, "rejected", decidedBy, msg);
      await client.query("COMMIT");
      return { suggestionId, applied: false, status: "rejected", reason: msg };
    }

    await client.query(
      `UPDATE project_tags
          SET alias_of = $1,
              updated_at = NOW()
        WHERE id = $2`,
      [targetRoot, sourceId]
    );

    await client.query(
      `UPDATE project_tag_alias_suggestions
          SET status = $2,
              decided_by = $3,
              decision_reason = $4,
              decided_at = NOW(),
              applied_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [suggestionId, appliedStatus, decidedBy, reason]
    );

    await client.query(
      `UPDATE project_tag_alias_suggestions
          SET status = 'superseded',
              decided_by = 'system',
              decision_reason = $4,
              decided_at = NOW(),
              updated_at = NOW()
        WHERE user_id = $1
          AND status = 'pending'
          AND id <> $2
          AND (source_tag_id = $3 OR target_tag_id = $3)`,
      [
        Number(suggestion.user_id),
        suggestionId,
        sourceId,
        `source tag ${sourceId} was aliased by suggestion ${suggestionId}`,
      ]
    );

    await client.query("COMMIT");
    invalidateCandidateCache();
    return { suggestionId, applied: true, status: appliedStatus };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

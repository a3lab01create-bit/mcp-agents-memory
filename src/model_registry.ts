/**
 * Role-based Model Registry — RESPEC v1.
 *
 * Providers: openai + xai + google (xai default — grok 사용).
 * Roles:
 *   - tagger    (Cold Path: predefined p_tag + dynamic d_tag 추출)
 *   - librarian (memory → user.core/sub_profile promote)
 *   - project_alias_judge (canonical project tag alias/same-project 판정)
 *
 * Embedding은 role 아니라 별도 모듈 (src/embeddings.ts)에서 OpenAI
 * embeddings API 직접 호출. 본 모듈의 EMBEDDING_MODEL 상수만 참조.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type Provider = 'openai' | 'google' | 'xai' | 'local';
export type Role = 'tagger' | 'librarian' | 'clusterer' | 'project_alias_judge';

export interface ModelSpec {
  provider: Provider;
  model_name: string;
}

export interface CallOptions {
  system: string;
  user: string;
  responseFormat?: 'json' | 'text';
  maxTokens?: number;
  /** local 프로바이더 전용: Qwen3 계열 /think 토글. 다른 프로바이더는 무시. */
  thinking?: boolean;
  /**
   * local 프로바이더 전용: json_schema 기반 grammar-constrained JSON 출력.
   * 제공 시 response_format:json_object 대신 json_schema 모드로 전환.
   * llama.cpp --jinja 플래그 필요.
   */
  jsonSchema?: Record<string, unknown>;
  /**
   * local 프로바이더 전용: llama.cpp thinking 토글 (chat_template_kwargs.enable_thinking).
   * jsonSchema와 동시에 true이면 경고 후 false로 강제 (llama.cpp #20345).
   */
  enableThinking?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Provider validation
// ─────────────────────────────────────────────────────────────

const KNOWN_PREFIXES: Record<Provider, string[]> = {
  openai: ['gpt-', 'o1-', 'o3-', 'text-embedding-'],
  google: ['gemini-'],
  xai:    ['grok-'],
  local:  [], // 모델명 제한 없음 (ollama 태그 형식: qwen3.5:9b 등)
};

export function assertModelProvider(spec: ModelSpec): void {
  if (spec.provider === 'local') return; // local은 모델명 형식 제한 없음
  const m = spec.model_name.toLowerCase();
  const valid = KNOWN_PREFIXES[spec.provider];
  if (!valid.some((p) => m.startsWith(p))) {
    throw new Error(
      `[ModelRegistry] Provider mismatch: model "${spec.model_name}" ` +
        `cannot be served by provider "${spec.provider}". ` +
        `Expected prefix: ${valid.join(' | ')}`
    );
  }
}

export function inferProvider(modelName: string): Provider | null {
  const lower = modelName.toLowerCase();
  for (const [provider, prefixes] of Object.entries(KNOWN_PREFIXES) as [Provider, string[]][]) {
    if (prefixes.some((p) => lower.startsWith(p))) return provider;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Role registry
// ─────────────────────────────────────────────────────────────

const DEFAULTS: Record<Role, ModelSpec> = {
  tagger:    { provider: 'xai', model_name: 'grok-4-1-fast-non-reasoning' },
  librarian: { provider: 'xai', model_name: 'grok-4-1-fast-non-reasoning' },
  clusterer: { provider: 'xai', model_name: 'grok-4-1-fast-non-reasoning' },
  project_alias_judge: { provider: 'local', model_name: 'gemma4:26b-a4b-it-q4_K_M' },
};

// local provider가 env에 명시된 경우 inferProvider가 null 반환하므로
// TAGGER_PROVIDER=local 를 명시 지정해야 함. 자동 추론 불가.
// 예: TAGGER_PROVIDER=local TAGGER_MODEL=qwen3.5:9b

function envEnvelope(role: Role): ModelSpec {
  const upper = role.toUpperCase();
  const explicitProvider = process.env[`${upper}_PROVIDER`] as Provider | undefined;
  const explicitModel = process.env[`${upper}_MODEL`];

  if (explicitProvider && explicitModel) {
    return { provider: explicitProvider, model_name: explicitModel };
  }
  if (explicitModel && !explicitProvider) {
    const inferred = inferProvider(explicitModel);
    if (!inferred) {
      console.error(
        `⚠️  [ModelRegistry] ${upper}_MODEL=${explicitModel} but no ${upper}_PROVIDER set, ` +
          `and the model prefix doesn't match openai/google. Falling back to default.`
      );
      return DEFAULTS[role];
    }
    return { provider: inferred, model_name: explicitModel };
  }
  if (explicitProvider && !explicitModel) {
    return { provider: explicitProvider, model_name: DEFAULTS[role].model_name };
  }
  return DEFAULTS[role];
}

export const ROLE_REGISTRY: Record<Role, ModelSpec> = {
  tagger:    envEnvelope('tagger'),
  librarian: envEnvelope('librarian'),
  clusterer: envEnvelope('clusterer'),
  project_alias_judge: envEnvelope('project_alias_judge'),
};

// Validate at module load — surfaces provider/model mismatch immediately.
for (const [role, spec] of Object.entries(ROLE_REGISTRY)) {
  try {
    assertModelProvider(spec as ModelSpec);
  } catch (err) {
    console.error(`❌ [ModelRegistry] Invalid config for role "${role}":`, err);
    throw err;
  }
}

/** Embedding model — OpenAI text-embedding-3-large (3072 dim) per RESPEC §2.e. */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-large';

// ─────────────────────────────────────────────────────────────
// Lazy clients
// ─────────────────────────────────────────────────────────────

let _openaiClient: OpenAI | null = null;
let _googleClient: GoogleGenerativeAI | null = null;
let _xaiClient: OpenAI | null = null;
let _localClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!_openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiClient;
}

function getXaiClient(): OpenAI {
  if (!_xaiClient) {
    if (!process.env.XAI_API_KEY) throw new Error("XAI_API_KEY missing");
    // xAI는 OpenAI-compat API (baseURL만 다름)
    _xaiClient = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' });
  }
  return _xaiClient;
}

function getGoogleClient(): GoogleGenerativeAI {
  if (!_googleClient) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    _googleClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _googleClient;
}

function getLocalClient(): OpenAI {
  if (!_localClient) {
    const baseURL = process.env.LOCAL_LLM_BASE_URL ?? 'http://localhost:11434/v1';
    // ollama는 API key 불필요 — 더미 문자열로 SDK 인증 에러 우회
    _localClient = new OpenAI({ apiKey: 'local', baseURL });
  }
  return _localClient;
}

// ─────────────────────────────────────────────────────────────
// Unified dispatcher
// ─────────────────────────────────────────────────────────────

/**
 * ModelSpec을 직접 받아 호출. callRole의 내부 구현이자 fallback 호출용 public API.
 */
export async function callSpec(spec: ModelSpec, opts: CallOptions): Promise<string> {
  assertModelProvider(spec);

  const maxTokens = opts.maxTokens ?? 4096;
  const useJson = opts.responseFormat === 'json';

  switch (spec.provider) {
    case 'openai': {
      const client = getOpenAIClient();
      const res = await client.chat.completions.create({
        model: spec.model_name,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        ...(useJson ? { response_format: { type: "json_object" as const } } : {}),
        temperature: 0.1,
        max_tokens: maxTokens,
      });
      return res.choices[0]?.message?.content || "";
    }
    case 'google': {
      const client = getGoogleClient();
      const model = client.getGenerativeModel({ model: spec.model_name });
      const res = await model.generateContent([
        { text: opts.system },
        { text: opts.user },
      ]);
      const raw = (await res.response).text();
      return raw.replace(/```json|```/g, "").trim();
    }
    case 'xai': {
      const client = getXaiClient();
      const res = await client.chat.completions.create({
        model: spec.model_name,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        ...(useJson ? { response_format: { type: "json_object" as const } } : {}),
        temperature: 0.1,
        max_tokens: maxTokens,
      });
      return (res.choices[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    }
    case 'local': {
      const client = getLocalClient();

      // llama.cpp #20345: enableThinking=true + jsonSchema は grammar を無視してしまう。
      // 両方セットされた場合は警告してthinkingをオフに強制する。
      let effectiveThinking = opts.enableThinking;
      if (opts.enableThinking === true && opts.jsonSchema) {
        console.warn(
          '[ModelRegistry] enableThinking + jsonSchema both set — forcing thinking OFF (llama.cpp #20345 silently bypasses grammar when thinking is on).'
        );
        effectiveThinking = false;
      }

      // response_format の優先順位:
      //   1. opts.jsonSchema → json_schema (grammar-constrained, llama.cpp --jinja 必須)
      //   2. useJson (responseFormat:'json') → json_object (旧来の互換パス)
      //   3. 指定なし → フリーテキスト
      const responseFormat: Record<string, unknown> | undefined = opts.jsonSchema
        ? {
            type: 'json_schema',
            json_schema: {
              name: 'librarian_profile',
              strict: true,
              schema: opts.jsonSchema,
            },
          }
        : useJson
          ? { type: 'json_object' as const }
          : undefined;

      // chat_template_kwargs はOpenAI SDK の型定義にない llama-server 拡張フィールド。
      // llama.cpp が --jinja フラグ付きで起動された場合にのみ有効。
      // 型安全のため params を一旦型付けしてから create() の引数でのみ Record でキャスト。
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: spec.model_name,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        ...(responseFormat ? { response_format: responseFormat as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format'] } : {}),
        temperature: 0.1,
        max_tokens: maxTokens,
      };

      const res = await client.chat.completions.create(
        // narrow cast: only this call site is widened to accommodate chat_template_kwargs
        {
          ...params,
          ...(effectiveThinking !== undefined
            ? { chat_template_kwargs: { enable_thinking: effectiveThinking } }
            : {}),
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & Record<string, unknown>
      );

      const raw = res.choices[0]?.message?.content || '';
      // <think>...</think> strip は defense-in-depth — thinking OFF 時も無害。
      return raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '').trim();
    }
  }
}

/**
 * Call a model by ROLE. Returns the raw string content from the model.
 */
export async function callRole(role: Role, opts: CallOptions): Promise<string> {
  const spec = ROLE_REGISTRY[role];
  return callSpec(spec, opts);
}

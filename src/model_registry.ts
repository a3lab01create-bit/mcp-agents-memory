/**
 * Role-based Model Registry — RESPEC v1.
 *
 * Providers: openai + google only (RESPEC §결정 — gemini + gpt만 유지).
 * Roles:
 *   - tagger    (Cold Path: predefined p_tag + dynamic d_tag 추출)
 *   - librarian (memory → user.core/sub_profile promote)
 *
 * Embedding은 role 아니라 별도 모듈 (src/embeddings.ts)에서 OpenAI
 * embeddings API 직접 호출. 본 모듈의 EMBEDDING_MODEL 상수만 참조.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type Provider = 'openai' | 'google';
export type Role = 'tagger' | 'librarian';

export interface ModelSpec {
  provider: Provider;
  model_name: string;
}

export interface CallOptions {
  system: string;
  user: string;
  responseFormat?: 'json' | 'text';
  maxTokens?: number;
}

// ─────────────────────────────────────────────────────────────
// Provider validation
// ─────────────────────────────────────────────────────────────

const KNOWN_PREFIXES: Record<Provider, string[]> = {
  openai: ['gpt-', 'o1-', 'o3-', 'text-embedding-'],
  google: ['gemini-'],
};

export function assertModelProvider(spec: ModelSpec): void {
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
  tagger:    { provider: 'google', model_name: 'gemini-2.5-flash' },
  librarian: { provider: 'google', model_name: 'gemini-2.5-flash' },
};

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

function getOpenAIClient(): OpenAI {
  if (!_openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiClient;
}

function getGoogleClient(): GoogleGenerativeAI {
  if (!_googleClient) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    _googleClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _googleClient;
}

// ─────────────────────────────────────────────────────────────
// Unified dispatcher
// ─────────────────────────────────────────────────────────────

/**
 * Call a model by ROLE. Returns the raw string content from the model.
 * Throws if the role's configured model doesn't match its provider.
 */
export async function callRole(role: Role, opts: CallOptions): Promise<string> {
  const spec = ROLE_REGISTRY[role];
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
  }
}

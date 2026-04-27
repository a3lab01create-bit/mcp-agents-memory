/**
 * Role-based Model Registry
 * 
 * Single source of truth for "which model handles which role"
 * and "which provider serves which model".
 * 
 * Goal: prevent Grok-endpoint-with-OpenAI-model class of bugs at boundary.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type Provider = 'openai' | 'anthropic' | 'google' | 'xai';
export type Role = 'triage' | 'extract' | 'audit' | 'contradiction' | 'skill_curator' | 'skill_auditor' | 'memory_auditor';

export interface ModelSpec {
  provider: Provider;
  model_name: string;
}

export interface CallOptions {
  system: string;
  user: string;
  responseFormat?: 'json' | 'text';
  maxTokens?: number;
  /**
   * When true on Anthropic calls, marks the system prompt with
   * `cache_control: { type: 'ephemeral' }`. Subsequent calls with the SAME
   * system prompt within the cache TTL (~5min) are billed at the cache-hit
   * rate (~10× cheaper). The first call pays a ~25% write premium, so set
   * this only on roles whose system prompt is stable AND likely to repeat
   * within the session (e.g. memory_auditor / skill_auditor across a batch
   * of facts). Anthropic only — ignored for other providers. Anthropic
   * additionally requires the cached portion to exceed a minimum token
   * count (~1024 for Sonnet), so very short prompts get no benefit.
   */
  cache?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Provider validation (the assertion layer)
// ─────────────────────────────────────────────────────────────

const KNOWN_PREFIXES: Record<Provider, string[]> = {
  openai:    ['gpt-', 'o1-', 'o3-', 'text-embedding-'],
  anthropic: ['claude-'],
  google:    ['gemini-'],
  xai:       ['grok-'],
};

export function assertModelProvider(spec: ModelSpec): void {
  const m = spec.model_name.toLowerCase();
  const valid = KNOWN_PREFIXES[spec.provider];
  if (!valid.some(p => m.startsWith(p))) {
    throw new Error(
      `[ModelRegistry] Provider mismatch: model "${spec.model_name}" ` +
      `cannot be served by provider "${spec.provider}". ` +
      `Expected prefix: ${valid.join(' | ')}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Role Registry — defaults + per-role env override
//
// Each role reads BOTH provider and model from env:
//   <ROLE>_PROVIDER  — 'openai' | 'anthropic' | 'google' | 'xai'
//   <ROLE>_MODEL     — exact model identifier passed to that provider
//
// Defaults below are tuned for cost/quality balance:
//   - High-frequency roles (triage/extract/audit/contradiction) → cheap models
//   - Opt-in grounding roles (skill/memory auditor) → quality models
//
// Users wanting "OpenAI only" or "Anthropic only" override via the wizard,
// which sets all 7 <ROLE>_PROVIDER + <ROLE>_MODEL pairs at once.
// ─────────────────────────────────────────────────────────────

const DEFAULTS: Record<Role, ModelSpec> = {
  triage:        { provider: 'google',    model_name: 'gemini-2.5-flash-lite' },
  extract:       { provider: 'openai',    model_name: 'gpt-4o-mini' },
  audit:         { provider: 'openai',    model_name: 'gpt-4o-mini' },
  contradiction: { provider: 'openai',    model_name: 'gpt-4o-mini' },
  skill_curator: { provider: 'openai',    model_name: 'gpt-4o-mini' },
  skill_auditor: { provider: 'anthropic', model_name: 'claude-sonnet-4-6' },
  memory_auditor: { provider: 'anthropic', model_name: 'claude-sonnet-4-6' },
};

/**
 * Infer provider from a model name's prefix. Used when a user sets
 * <ROLE>_MODEL without an accompanying <ROLE>_PROVIDER — common for
 * .env files migrated from the pre-PROVIDER schema.
 */
function inferProvider(modelName: string): Provider | null {
  const lower = modelName.toLowerCase();
  for (const [provider, prefixes] of Object.entries(KNOWN_PREFIXES) as [Provider, string[]][]) {
    if (prefixes.some((p) => lower.startsWith(p))) return provider;
  }
  return null;
}

function envEnvelope(role: Role): ModelSpec {
  const upper = role.toUpperCase();
  const explicitProvider = process.env[`${upper}_PROVIDER`] as Provider | undefined;
  const explicitModel = process.env[`${upper}_MODEL`];

  if (explicitProvider && explicitModel) {
    return { provider: explicitProvider, model_name: explicitModel };
  }
  if (explicitModel && !explicitProvider) {
    // Migration friendliness: pre-existing .env files set MODEL only.
    const inferred = inferProvider(explicitModel);
    if (!inferred) {
      console.error(
        `⚠️  [ModelRegistry] ${upper}_MODEL=${explicitModel} but no ${upper}_PROVIDER set, ` +
          `and the model prefix doesn't match any known provider. Falling back to default.`
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
  triage:        envEnvelope('triage'),
  extract:       envEnvelope('extract'),
  audit:         envEnvelope('audit'),
  contradiction: envEnvelope('contradiction'),
  skill_curator: envEnvelope('skill_curator'),
  skill_auditor: envEnvelope('skill_auditor'),
  memory_auditor: envEnvelope('memory_auditor'),
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

/** Embedding model is not a "role" but follows the same env override pattern. */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';

// ─────────────────────────────────────────────────────────────
// Client Factories (lazy)
// ─────────────────────────────────────────────────────────────

let _openaiClient: OpenAI | null = null;
let _anthropicClient: Anthropic | null = null;
let _grokClient: OpenAI | null = null;
let _googleClient: GoogleGenerativeAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!_openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiClient;
}

function getAnthropicClient(): Anthropic {
  if (!_anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
    _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropicClient;
}

function getGrokClient(): OpenAI {
  if (!_grokClient) {
    if (!process.env.GROK_API_KEY) throw new Error("GROK_API_KEY missing");
    _grokClient = new OpenAI({ apiKey: process.env.GROK_API_KEY, baseURL: "https://api.x.ai/v1" });
  }
  return _grokClient;
}

function getGoogleClient(): GoogleGenerativeAI {
  if (!_googleClient) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    _googleClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _googleClient;
}

// ─────────────────────────────────────────────────────────────
// Unified Dispatcher
// ─────────────────────────────────────────────────────────────

/**
 * Call a model by ROLE. Returns the raw string content from the model.
 * Throws if the role's configured model doesn't match its provider.
 */
export async function callRole(role: Role, opts: CallOptions): Promise<string> {
  const spec = ROLE_REGISTRY[role];
  assertModelProvider(spec); // belt-and-suspenders: also enforced at call time

  const maxTokens = opts.maxTokens ?? 4096;
  const useJson = opts.responseFormat === 'json';

  switch (spec.provider) {
    case 'openai':
    case 'xai': {
      const client = spec.provider === 'openai' ? getOpenAIClient() : getGrokClient();
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
    case 'anthropic': {
      const client = getAnthropicClient();
      const systemBlock = opts.cache
        ? [{ type: "text" as const, text: opts.system, cache_control: { type: "ephemeral" as const } }]
        : opts.system;
      const res = await client.messages.create({
        model: spec.model_name,
        max_tokens: maxTokens,
        system: systemBlock as any,
        messages: [{ role: "user", content: opts.user }],
      });
      return (res.content[0] as any).text || "";
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

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
export type Role = 'triage' | 'extract' | 'audit' | 'contradiction' | 'skill_curator' | 'skill_auditor';

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
// Role Registry
// ─────────────────────────────────────────────────────────────

export const ROLE_REGISTRY: Record<Role, ModelSpec> = {
  triage:        { provider: 'google',    model_name: process.env.TRIAGE_MODEL        || 'gemini-2.0-flash-exp' },
  extract:       { provider: 'openai',    model_name: process.env.EXTRACT_MODEL       || 'gpt-4o-mini' },
  audit:         { provider: 'xai',       model_name: process.env.AUDIT_MODEL         || 'grok-2-latest' },
  contradiction: { provider: 'openai',    model_name: process.env.CONTRADICTION_MODEL || 'gpt-4o-mini' },
  skill_curator: { provider: 'openai',    model_name: process.env.SKILL_CURATOR_MODEL || 'gpt-4o-mini' },
  skill_auditor: { provider: 'anthropic', model_name: process.env.SKILL_AUDITOR_MODEL || 'claude-sonnet-4-6' },
};

// Validate at module load
for (const [role, spec] of Object.entries(ROLE_REGISTRY)) {
  try {
    assertModelProvider(spec as ModelSpec);
  } catch (err) {
    console.error(`❌ [ModelRegistry] Invalid config for role "${role}":`, err);
    throw err;
  }
}

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
      const res = await client.messages.create({
        model: spec.model_name,
        max_tokens: maxTokens,
        system: opts.system,
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

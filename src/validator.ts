import { db } from "./db.js";
import OpenAI from "openai";
import {
  getAuthority,
  authorityToWeight,
  searchExternal,
} from "./external_search.js";

export { getAuthority, authorityToWeight } from "./external_search.js";

function getGrokClient() {
  if (!process.env.GROK_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.GROK_API_KEY,
    baseURL: "https://api.x.ai/v1",
  });
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type ValidationStatus = 'pending' | 'valid' | 'invalid' | 'contested';

export interface ValidationReport {
  status: ValidationStatus;
  confidence_score: number;
  reasoning: string;
  sources: Array<{ 
    title: string; 
    url: string; 
    snippet: string; 
    engine: 'tavily' | 'exa';
    weight?: number;
    authority?: 'high' | 'medium' | 'low';
  }>;
}

// ─────────────────────────────────────────────────────────────
// Core Logic
// ─────────────────────────────────────────────────────────────

/**
 * Validate a fact using external search engines and a reasoning model.
 */
export async function validateFact(factContent: string, factId: number): Promise<ValidationReport> {
  console.error(`🔍 [Validator] Grounding fact #${factId}: "${factContent.substring(0, 50)}..."`);
  
  const report: ValidationReport = {
    status: 'pending',
    confidence_score: 0,
    reasoning: '',
    sources: []
  };

  try {
    report.sources.push(...await searchExternal(factContent));

    if (report.sources.length === 0) {
      report.status = 'contested';
      report.reasoning = "No external sources found to verify this fact.";
      return report;
    }

    // 3. Final Synthesis using Grok (Reasoning Model)
    const grok = getGrokClient();
    if (!grok) {
      report.status = 'contested';
      report.reasoning = "Search succeeded but no Reasoning Model available for synthesis.";
      return report;
    }

    const synthesisPrompt = `You are a Fact Validation Specialist.
Compare the following FACT against the provided SEARCH SOURCES.

FACT: "${factContent}"

SOURCES:
${report.sources.map((s, i) => `[${i}] (${s.engine}, Weight: ${s.weight}, Authority: ${s.authority}) ${s.title}: ${s.snippet}`).join("\n\n")}

CRITICAL INSTRUCTIONS:
- If high-weight sources provide conflicting information, return "contested".
- Prioritize sources with 'high' authority (official documentation, .gov, .edu).
- If sources are outdated or snippets are irrelevant, lower their weight in your mind and return "contested" if no other clear proof exists.

OUTPUT FORMAT (JSON):
{
  "status": "valid" | "invalid" | "contested",
  "confidence_score": 0.0 to 1.0,
  "reasoning": "Explain your verdict, specifically mentioning which high-authority sources were used."
}`;

    const synthRes = await grok.chat.completions.create({
      model: process.env.AUDIT_MODEL || "grok-4.20-0309-reasoning",
      messages: [{ role: "user", content: synthesisPrompt }],
      response_format: { type: "json_object" }
    });

    const parsed = JSON.parse(synthRes.choices[0]?.message?.content || "{}");
    report.status = parsed.status || 'contested';
    report.confidence_score = parsed.confidence_score || 0.5;
    report.reasoning = parsed.reasoning || "Synthesis failed.";

    // 4. Save Validation Result to DB
    await saveValidationResult(factId, report);

  } catch (err) {
    console.error(`❌ [Validator] Validation FAILED for fact #${factId}:`, err);
    report.status = 'contested';
    report.reasoning = `Error during validation: ${err}`;
  }

  return report;
}

async function saveValidationResult(factId: number, report: ValidationReport) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    
    // Insert into fact_validations
    const insertRes = await client.query(
      `INSERT INTO fact_validations (fact_id, status, confidence_score, research_report, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [factId, report.status, report.confidence_score, report.reasoning, JSON.stringify({ sources: report.sources })]
    );

    // Update memories table status
    await client.query(
      `UPDATE memories SET validation_status = $1, last_validated_at = NOW() WHERE id = $2`,
      [report.status, factId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`❌ [Validator] Failed to save validation to DB for fact #${factId}:`, err);
  } finally {
    client.release();
  }
}

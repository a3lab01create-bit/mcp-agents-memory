import OpenAI from "openai";

let client: OpenAI | null = null;
let _warned = false;

function isAvailable(): boolean {
  if (process.env.OPENAI_API_KEY) return true;
  if (!_warned) {
    console.error("⚠️ OPENAI_API_KEY not set — semantic search disabled. Add it to .env or run setup again.");
    _warned = true;
  }
  return false;
}

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!isAvailable()) return null;

  try {
    const response = await getClient().embeddings.create({
      model: "text-embedding-3-small",
      input: text.substring(0, 8000),
    });
    return response.data[0].embedding;
  } catch (err) {
    console.error("⚠️ Embedding generation failed:", err);
    return null;
  }
}

export function vectorToSql(embedding: number[] | null): string | null {
  if (!embedding) return null;
  return `[${embedding.join(",")}]`;
}

import OpenAI from "openai";
import { EMBEDDING_MODEL } from "./model_registry.js";
let client = null;
let _warned = false;
function isAvailable() {
    if (process.env.OPENAI_API_KEY)
        return true;
    if (!_warned) {
        console.error("⚠️ OPENAI_API_KEY not set — semantic search disabled. Add it to .env or run setup again.");
        _warned = true;
    }
    return false;
}
export function getClient() {
    if (!client) {
        client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return client;
}
export async function generateEmbedding(text) {
    if (!isAvailable())
        return null;
    try {
        const response = await getClient().embeddings.create({
            model: EMBEDDING_MODEL,
            input: text.substring(0, 8000),
        });
        return response.data[0].embedding;
    }
    catch (err) {
        console.error("⚠️ Embedding generation failed:", err);
        return null;
    }
}
export function vectorToSql(embedding) {
    if (!embedding)
        return null;
    return `[${embedding.join(",")}]`;
}

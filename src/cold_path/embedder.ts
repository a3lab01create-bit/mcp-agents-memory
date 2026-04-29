/**
 * Cold Path Embedder — text → vector(3072) (text-embedding-3-large).
 *
 * 실제 embedding 호출은 src/embeddings.ts:generateEmbedding() 사용.
 * 본 모듈은 retry 로직 + halfvec SQL literal 변환만 담당.
 */

import { generateEmbedding } from "../embeddings.js";

const MAX_RETRIES = 3;

/**
 * Retry 시도 후 embedding 반환. 실패 시 throw — Cold Path worker가
 * cold_error 컬럼에 기록 + 다음 사이클에 자동 재시도.
 */
export async function embedMessage(message: string): Promise<number[]> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const emb = await generateEmbedding(message);
      if (!emb) throw new Error("generateEmbedding returned null (OPENAI_API_KEY missing?)");
      if (emb.length !== 3072) {
        throw new Error(`Unexpected embedding dimension: got ${emb.length}, want 3072. Check EMBEDDING_MODEL env (must be text-embedding-3-large).`);
      }
      return emb;
    } catch (err) {
      lastErr = err;
      const isRateLimit = (err as any)?.status === 429;
      const isTransient = isRateLimit || (err as any)?.code === 'ETIMEDOUT' || (err as any)?.code === 'ECONNRESET';
      if (attempt < MAX_RETRIES && isTransient) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      // non-transient 또는 final failure: throw
      break;
    }
  }
  throw lastErr ?? new Error("Embedder failed after retries");
}

/** 3072 number[] → halfvec SQL literal '[a,b,c,...]'. */
export function vectorToHalfvecSql(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

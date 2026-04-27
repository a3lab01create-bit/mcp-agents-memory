import { db } from "./db.js";

/**
 * Read-only subject lookup. Returns null if not found.
 * Use in search paths to avoid phantom subject creation.
 */
export async function getSubjectId(subject_key: string): Promise<number | null> {
  const res = await db.query("SELECT id FROM subjects WHERE subject_key = $1", [subject_key]);
  return res.rows.length > 0 ? res.rows[0].id : null;
}

/**
 * Atomic upsert. Race-safe via ON CONFLICT DO UPDATE.
 * Type guessed from prefix; falls back to `fallback_type`.
 */
export async function getOrCreateSubject(subject_key: string | undefined | null, fallback_type: string = 'system'): Promise<number> {
  const finalKey = subject_key || 'system_global';

  let guessedType = fallback_type;
  if (finalKey.startsWith('user_')) guessedType = 'person';
  else if (finalKey.startsWith('project_')) guessedType = 'project';
  else if (finalKey.startsWith('agent_')) guessedType = 'agent';
  else if (finalKey.startsWith('team_')) guessedType = 'team';
  else if (finalKey.startsWith('category_')) guessedType = 'category';
  else if (finalKey.startsWith('system_')) guessedType = 'system';

  const res = await db.query(
    `INSERT INTO subjects (subject_type, subject_key, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (subject_key) DO UPDATE SET subject_key = EXCLUDED.subject_key
     RETURNING id`,
    [guessedType, finalKey, finalKey]
  );
  return res.rows[0].id;
}

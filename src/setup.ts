/**
 * Interactive setup wizard.
 *
 * Phase A4 stub: 옛 wizard는 wrong-axis schema (memories with fact_type,
 * subjects, skills 등) 작성 + 7개 role .env 작성. RESPEC v1과 정합 안 됨.
 *
 * Phase G에서 RESPEC v1 정합 wizard로 재작성:
 *   - DB 연결 정보 prompt
 *   - OPENAI_API_KEY + GEMINI_API_KEY prompt
 *   - 새 schema migration 적용 (018_respec_fresh_v1.sql)
 *   - 기본 user 생성 (users(user_name='hoon') INSERT)
 *
 * 그 전에 setup wizard 호출 시 명시적 안내.
 */

export async function runSetupWizard(): Promise<void> {
  console.log("");
  console.log("⚠️  Setup wizard is being rewritten for RESPEC v1 (fresh impl).");
  console.log("");
  console.log("Until Phase G ships the new wizard:");
  console.log("  1. Edit .env directly (see RESPEC.md / README.md for required vars).");
  console.log("  2. Run `mcp-agents-memory migrate` to apply new schema.");
  console.log("  3. Manually INSERT one row into users (e.g. user_name='hoon').");
  console.log("");
  console.log("RESPEC.md: https://github.com/<repo>/blob/main/RESPEC.md");
  console.log("");
  process.exit(1);
}

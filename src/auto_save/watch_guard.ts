/**
 * fs.watch 감시기에 'error' 처리를 붙인다 (0.9.40).
 *
 * 왜: FSWatcher 에 'error' 리스너가 없으면 Node 가 그 오류를 예외로 던져 **서버 프로세스가 통째로 죽는다**.
 * 2026-11-21 08:22 몰타르: 재귀 감시(recursive) 아래 새 폴더가 생기는 순간 사용자당 inotify 한도
 * (max_user_watches 65,536)가 차 있어서 ENOSPC → 메모리 서버가 전부 꺼졌고, 클로드 코드는 다시 띄우지
 * 않아 그 뒤 대화가 저장되지 않았다. 컨테이너 안 별도 uid 로 재현: 리스너 없으면 exit 1,
 * 있으면 산다. (jsonl_capture 는 EACCES 재현 뒤 이미 리스너가 있었다.)
 *
 * 처리: 그 감시기만 닫고 한 번 알린다. 각 수집기는 감시와 별개로 3초 폴링을 돌리므로 수집은 계속된다.
 */
import type * as fs from "node:fs";

export function guardWatcher(w: fs.FSWatcher, label: string, onClosed?: () => void): fs.FSWatcher {
  let reported = false;
  w.on("error", (err: unknown) => {
    if (!reported) {
      reported = true;
      const e = err as NodeJS.ErrnoException;
      console.error(`⚠️ [${label}] fs.watch error (${e?.code ?? "?"}) — watcher closed, polling continues:`, e?.message ?? err);
    }
    try { w.close(); } catch { /* 이미 닫힘 */ }
    try { onClosed?.(); } catch { /* 정리 실패로 죽지 않게 */ }
  });
  return w;
}

import { runCurator } from "./curator.js";

let warmupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let running = false;

const DEFAULT_WARMUP_MIN = 5;
const DEFAULT_INTERVAL_MIN = 60;

function parseMinutes(raw: string | undefined, fallback: number, label: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if ((label === 'interval' && parsed < 1) || (label === 'warmup' && parsed < 0)) {
    console.error(`🌀 [Promotion] invalid ${label}=${raw}; using default ${fallback}min`);
    return fallback;
  }
  return parsed;
}

export function maybeStartPromotionLoop(): void {
  if (process.env.PROMOTION_ENABLED !== 'true') {
    console.error("🌀 [Promotion] disabled (set PROMOTION_ENABLED=true to enable)");
    return;
  }

  if (warmupTimer || intervalTimer) {
    return;
  }

  const warmupMin = parseMinutes(process.env.PROMOTION_WARMUP_MIN, DEFAULT_WARMUP_MIN, 'warmup');
  const intervalMin = parseMinutes(process.env.PROMOTION_INTERVAL_MIN, DEFAULT_INTERVAL_MIN, 'interval');

  warmupTimer = setTimeout(() => {
    warmupTimer = null;
    void tickPromotionLoop();
    intervalTimer = setInterval(() => {
      void tickPromotionLoop();
    }, intervalMin * 60 * 1000);
  }, warmupMin * 60 * 1000);

  console.error(`🌀 [Promotion] scheduled: warmup=${warmupMin}min, interval=${intervalMin}min`);
}

async function tickPromotionLoop(): Promise<void> {
  if (running) {
    console.error("🌀 [Promotion] skip overlap");
    return;
  }

  running = true;
  const startedAt = Date.now();
  console.error("🌀 [Promotion] tick start");

  try {
    const result = await runCurator({});
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(
      `🌀 [Promotion] tick done — scanned=${result.scanned_memories}, clusters=${result.clusters_found}, skipped=${result.clusters_skipped}, saved=${result.skills_saved} (in ${durationSec}s)`
    );
  } catch (err) {
    console.error(`🌀 [Promotion] tick failed — ${err}`);
  } finally {
    running = false;
  }
}

export function stopPromotionLoop(): void {
  if (warmupTimer) {
    clearTimeout(warmupTimer);
    warmupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

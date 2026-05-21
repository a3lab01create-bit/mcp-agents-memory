#!/usr/bin/env bash
# setup_local_llm.sh — ollama(ROCm) 설치 + Qwen 모델 pull
#
# 대상: AMD RX 6800 XT (gfx1030, RDNA2), Ubuntu 26.04, ROCm 7.1 이미 설치됨
#
# 사용법:
#   bash scripts/setup_local_llm.sh [--models-only]
#   --models-only: ollama 이미 설치된 경우 모델 pull만 실행

set -euo pipefail

TAGGER_MODEL="${TAGGER_LOCAL_MODEL:-qwen3.5:9b}"
LIBRARIAN_MODEL="${LIBRARIAN_LOCAL_MODEL:-qwen3.6:35b-a3b}"
MODELS_ONLY=false

for arg in "$@"; do
  [[ "$arg" == "--models-only" ]] && MODELS_ONLY=true
done

echo "======================================================"
echo "  mcp-agents-memory local LLM setup"
echo "  GPU: AMD RX 6800 XT (gfx1030, ROCm 7.1)"
echo "  Tagger model:    $TAGGER_MODEL"
echo "  Librarian model: $LIBRARIAN_MODEL"
echo "======================================================"

# ── 1. ollama 설치 ────────────────────────────────────────
if ! $MODELS_ONLY; then
  if command -v ollama &>/dev/null; then
    echo "✅ ollama already installed: $(ollama --version)"
  else
    echo "📦 Installing ollama (ROCm build)..."
    curl -fsSL https://ollama.com/install.sh | sh

    # gfx1030 quirk: 일부 ROCm 버전에서 gfx1030을 명시해야 올바른 커널 선택
    # /etc/systemd/system/ollama.service.d/ 에 환경변수 추가
    if systemctl is-enabled ollama &>/dev/null 2>&1; then
      sudo mkdir -p /etc/systemd/system/ollama.service.d
      sudo tee /etc/systemd/system/ollama.service.d/rocm-gfx.conf >/dev/null <<'EOF'
[Service]
Environment="HSA_OVERRIDE_GFX_VERSION=10.3.0"
Environment="ROCR_VISIBLE_DEVICES=0"
EOF
      sudo systemctl daemon-reload
      sudo systemctl restart ollama
      echo "✅ ollama service restarted with gfx1030 env"
    else
      # 서비스 없으면 실행 시 환경변수 직접 설정 필요 (아래 안내 참조)
      echo "⚠️  ollama systemd service not found. ollama 직접 실행 시:"
      echo "   HSA_OVERRIDE_GFX_VERSION=10.3.0 ollama serve &"
    fi
  fi
fi

# ── 2. ollama 서비스 확인 ─────────────────────────────────
echo ""
echo "🔍 ollama 서비스 확인..."
if ! ollama list &>/dev/null 2>&1; then
  echo "⚠️  ollama 서버가 응답하지 않습니다. 수동 시작:"
  echo "   HSA_OVERRIDE_GFX_VERSION=10.3.0 ollama serve &"
  echo "   그 후 이 스크립트를 --models-only 로 다시 실행하세요."
  exit 1
fi
echo "✅ ollama server OK"

# ── 3. 모델 pull ──────────────────────────────────────────
echo ""
echo "📥 Tagger model: $TAGGER_MODEL"
echo "   ℹ️  정확한 태그는 https://ollama.com/library/qwen3.5 에서 확인"
ollama pull "$TAGGER_MODEL" || {
  echo "❌ $TAGGER_MODEL pull 실패. 태그 확인 후 재시도:"
  echo "   ollama list  # 사용 가능한 모델 확인"
  echo "   ollama pull qwen3.5  # 기본 태그로 시도"
  exit 1
}

echo ""
echo "📥 Librarian model: $LIBRARIAN_MODEL"
echo "   ℹ️  35B MoE — 약 20GB 다운로드. 60GB RAM에서 GPU offload 조합으로 실행."
echo "   정확한 태그는 https://ollama.com/library/qwen3.6 에서 확인"
ollama pull "$LIBRARIAN_MODEL" || {
  echo "⚠️  $LIBRARIAN_MODEL pull 실패. 더 작은 대안:"
  echo "   ollama pull qwen3.6:27b  # 16GB 빡빡하지만 GPU 상주 가능"
  echo "   ollama pull qwen3.5:9b   # 태거 모델로 Librarian도 겸용"
}

# ── 4. 스모크 테스트 ──────────────────────────────────────
echo ""
echo "🧪 스모크 테스트: $TAGGER_MODEL JSON 출력 확인..."
SMOKE=$(ollama run "$TAGGER_MODEL" \
  '/no_think
{"p_tag": null, "d_tag": []}' 2>/dev/null | tr -d '\n' | head -c 200 || echo "FAILED")

if echo "$SMOKE" | grep -q '"p_tag"'; then
  echo "✅ JSON 출력 확인됨"
else
  echo "⚠️  스모크 테스트 불안정 (정상일 수 있음 — 벤치로 검증)"
  echo "   출력: $SMOKE"
fi

# ── 5. .env 설정 안내 ─────────────────────────────────────
echo ""
echo "======================================================"
echo "  ✅ 설치 완료! .env에 아래 설정 추가하면 로컬 태거 활성화:"
echo ""
echo "  TAGGER_PROVIDER=local"
echo "  TAGGER_MODEL=$TAGGER_MODEL"
echo "  LIBRARIAN_PROVIDER=local"
echo "  LIBRARIAN_MODEL=$LIBRARIAN_MODEL"
echo "  LOCAL_LLM_BASE_URL=http://localhost:11434/v1"
echo "  LOCAL_GROK_FALLBACK=true   # 로컬 실패 시 grok 자동 fallback"
echo ""
echo "  ⚠️  활성화 전에 벤치 먼저 실행:"
echo "  npx tsx scripts/bench_local_tagger.ts"
echo "======================================================"

#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<'EOF'
Usage:
  smoke-agent-postprocess.sh --ready
  smoke-agent-postprocess.sh --live

--ready checks the local Codex wrapper health without running a job.
--live creates a temporary raw bundle under runtime/agent-smoke and runs the Codex postprocess wrapper.
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
wrapper="$script_dir/run-codex-postprocess.sh"

mode="${1:---ready}"
case "$mode" in
  --help|-h)
    print_usage
    exit 0
    ;;
  --ready|--live)
    ;;
  *)
    echo "smoke-agent-postprocess: unknown mode: $mode" >&2
    print_usage >&2
    exit 2
    ;;
esac

if [[ ! -x "$wrapper" ]]; then
  echo "smoke-agent-postprocess: wrapper is not executable: $wrapper" >&2
  exit 2
fi

echo "Agent postprocess smoke readiness:"
"$wrapper" --health
echo "OK   Codex wrapper health passed"
echo "OK   command example:"
echo "     AGENT_POSTPROCESS_PROVIDER=codex"
echo "     AGENT_POSTPROCESS_COMMAND=$wrapper --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}"

if [[ "$mode" == "--ready" ]]; then
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
job_id="agent-smoke-$stamp"
smoke_root="$project_root/runtime/agent-smoke/$job_id"
raw_root="$smoke_root/raw"
bundle_path="$raw_root/2026-04-23/$job_id"
output_dir="$smoke_root/output"
work_dir="$smoke_root/work"
prompt_file="$work_dir/prompt.md"

mkdir -p "$bundle_path/extracted" "$output_dir" "$work_dir"
cat >"$bundle_path/source.md" <<'EOF'
# Source

This is a short English vendor update that should be translated into Korean and formatted as a concise business memo.
EOF
cat >"$bundle_path/manifest.yaml" <<EOF
id: "$job_id"
finalized: true
EOF
touch "$bundle_path/.finalized"
cat >"$prompt_file" <<EOF
# Telegram Local Ingest Post-Processing

Read the finalized raw bundle at: $bundle_path
Write generated deliverables only under: $output_dir
Do not modify raw files.

Translate the source into Korean, preserve business tone, and create translated.md.
EOF

"$wrapper" --prompt "$prompt_file" --output "$output_dir" --bundle "$bundle_path" --job "$job_id"

if ! find "$output_dir" -maxdepth 2 -type f | grep -q .; then
  echo "smoke-agent-postprocess: no output files were created under $output_dir" >&2
  exit 1
fi

echo "OK   live agent smoke created output under $output_dir"

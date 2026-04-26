#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<'EOF'
Usage:
  run-claude-postprocess.sh --health
  run-claude-postprocess.sh --prompt <prompt.md> --output <dir> --bundle <raw-bundle-dir> --job <job-id>

This wrapper is intended for AGENT_POSTPROCESS_COMMAND:
  {projectRoot}/scripts/run-claude-postprocess.sh --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}

Optional tuning:
  CLAUDE_BIN=claude
  CLAUDE_MODEL=sonnet
  CLAUDE_PERMISSION_MODE=acceptEdits
  CLAUDE_ALLOWED_TOOLS=Read,Write,Edit,MultiEdit,Glob,Grep
  CLAUDE_MAX_BUDGET_USD=1.00
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
claude_bin="${CLAUDE_BIN:-claude}"

run_health() {
  if ! command -v "$claude_bin" >/dev/null 2>&1; then
    echo "run-claude-postprocess: claude CLI not found: $claude_bin" >&2
    return 1
  fi

  local version
  if ! version="$("$claude_bin" --version 2>&1)"; then
    echo "run-claude-postprocess: claude --version failed: $version" >&2
    return 1
  fi
  echo "claude-cli $(printf '%s\n' "$version" | sed -n '1p')"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_usage
  exit 0
fi

if [[ "${1:-}" == "--health" || "${1:-}" == "--version" ]]; then
  run_health
  exit $?
fi

prompt_file=""
output_dir=""
bundle_path=""
job_id=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt|--prompt-file)
      prompt_file="${2:-}"
      shift 2
      ;;
    --output|--output-dir)
      output_dir="${2:-}"
      shift 2
      ;;
    --bundle|--bundle-path)
      bundle_path="${2:-}"
      shift 2
      ;;
    --job|--job-id)
      job_id="${2:-}"
      shift 2
      ;;
    *)
      echo "run-claude-postprocess: unknown argument: $1" >&2
      print_usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$prompt_file" || -z "$output_dir" || -z "$bundle_path" || -z "$job_id" ]]; then
  echo "run-claude-postprocess: --prompt, --output, --bundle, and --job are required" >&2
  print_usage >&2
  exit 2
fi

if [[ ! -f "$prompt_file" ]]; then
  echo "run-claude-postprocess: prompt file not found: $prompt_file" >&2
  exit 2
fi

if [[ ! -d "$bundle_path" ]]; then
  echo "run-claude-postprocess: raw bundle not found: $bundle_path" >&2
  exit 2
fi

mkdir -p "$output_dir"
agent_root="$(cd "$(dirname "$output_dir")" && pwd)"

cat >"$agent_root/postprocess-contract.md" <<EOF
# Local Agent Contract

- Job id: $job_id
- Raw bundle: $bundle_path
- Output directory: $output_dir
- Project root: $project_root

The raw bundle is source evidence. Do not modify it.
Create final downloadable deliverables only in the output directory.
EOF

prompt_payload="$(cat "$prompt_file")"
permission_mode="${CLAUDE_PERMISSION_MODE:-acceptEdits}"
output_format="${CLAUDE_OUTPUT_FORMAT:-text}"

claude_args=(
  --print
  --input-format text
  --output-format "$output_format"
  --permission-mode "$permission_mode"
  --no-session-persistence
  --add-dir "$agent_root"
  --add-dir "$bundle_path"
  --add-dir "$output_dir"
)

if [[ -n "${CLAUDE_MODEL:-}" ]]; then
  claude_args+=(--model "$CLAUDE_MODEL")
fi

if [[ -n "${CLAUDE_ALLOWED_TOOLS:-}" ]]; then
  claude_args+=(--allowedTools "$CLAUDE_ALLOWED_TOOLS")
fi

if [[ -n "${CLAUDE_MAX_BUDGET_USD:-}" ]]; then
  claude_args+=(--max-budget-usd "$CLAUDE_MAX_BUDGET_USD")
fi

cd "$agent_root"
printf '%s\n\n---\n\nSee also: %s\n' "$prompt_payload" "$agent_root/postprocess-contract.md" | "$claude_bin" "${claude_args[@]}"

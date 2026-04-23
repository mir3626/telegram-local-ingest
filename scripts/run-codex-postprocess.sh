#!/usr/bin/env bash
set -euo pipefail

print_usage() {
  cat <<'EOF'
Usage:
  run-codex-postprocess.sh --health
  run-codex-postprocess.sh --prompt <prompt.md> --output <dir> --bundle <raw-bundle-dir> --job <job-id>

This wrapper is intended for AGENT_POSTPROCESS_COMMAND:
  {projectRoot}/scripts/run-codex-postprocess.sh --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
run_codex="$script_dir/run-codex.sh"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_usage
  exit 0
fi

if [[ "${1:-}" == "--health" || "${1:-}" == "--version" ]]; then
  "$run_codex" --health
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
      echo "run-codex-postprocess: unknown argument: $1" >&2
      print_usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$prompt_file" || -z "$output_dir" || -z "$bundle_path" || -z "$job_id" ]]; then
  echo "run-codex-postprocess: --prompt, --output, --bundle, and --job are required" >&2
  print_usage >&2
  exit 2
fi

if [[ ! -f "$prompt_file" ]]; then
  echo "run-codex-postprocess: prompt file not found: $prompt_file" >&2
  exit 2
fi

if [[ ! -d "$bundle_path" ]]; then
  echo "run-codex-postprocess: raw bundle not found: $bundle_path" >&2
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

cd "$agent_root"
printf '%s\n\n---\n\nSee also: %s\n' "$prompt_payload" "$agent_root/postprocess-contract.md" | "$run_codex" -

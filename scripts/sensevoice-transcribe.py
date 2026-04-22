#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path


def progress(percent: int, stage: str, message: str) -> None:
    payload = {
        "type": "sensevoice_progress",
        "percent": percent,
        "stage": stage,
        "message": message,
    }
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"invalid boolean: {value}")


def main() -> None:
    progress(1, "START", "Parsing SenseVoice command arguments")
    parser = argparse.ArgumentParser(description="Run SenseVoice transcription for telegram-local-ingest.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="iic/SenseVoiceSmall")
    parser.add_argument("--vad-model", default="fsmn-vad")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--use-itn", type=parse_bool, default=True)
    parser.add_argument("--batch-size-s", type=int, default=60)
    parser.add_argument("--merge-vad", type=parse_bool, default=True)
    parser.add_argument("--merge-length-s", type=int, default=15)
    parser.add_argument("--max-single-segment-time-ms", type=int, default=30000)
    args = parser.parse_args()

    progress(5, "CONFIG", f"Input={args.input} model={args.model} device={args.device} language={args.language}")
    torch_threads = os.environ.get("TORCH_NUM_THREADS")
    if torch_threads:
        try:
            progress(8, "THREADS", f"Setting torch CPU threads to {torch_threads}")
            import torch

            torch.set_num_threads(int(torch_threads))
        except Exception:
            pass

    progress(12, "IMPORT", "Importing FunASR and SenseVoice dependencies")
    from funasr import AutoModel
    from funasr.utils.postprocess_utils import rich_transcription_postprocess
    progress(20, "IMPORT", "FunASR dependencies imported")

    model_kwargs = {
        "model": args.model,
        "device": args.device,
    }
    if args.vad_model:
        model_kwargs["vad_model"] = args.vad_model
        model_kwargs["vad_kwargs"] = {"max_single_segment_time": args.max_single_segment_time_ms}

    progress(25, "MODEL_LOAD", "Loading SenseVoice model")
    model = AutoModel(**model_kwargs)
    progress(45, "MODEL_LOAD", "SenseVoice model loaded")
    generate_kwargs = {
        "input": args.input,
        "cache": {},
        "language": args.language,
        "use_itn": args.use_itn,
        "batch_size_s": args.batch_size_s,
    }
    if args.vad_model:
        generate_kwargs["merge_vad"] = args.merge_vad
        generate_kwargs["merge_length_s"] = args.merge_length_s

    progress(50, "TRANSCRIBE", "Running SenseVoice transcription")
    result = model.generate(**generate_kwargs)
    progress(85, "TRANSCRIBE", "SenseVoice transcription finished")
    segments = []
    texts = []
    progress(88, "POSTPROCESS", "Post-processing transcript text")
    for index, item in enumerate(result if isinstance(result, list) else [result]):
        if not isinstance(item, dict):
            continue
        raw_text = str(item.get("text", ""))
        text = rich_transcription_postprocess(raw_text).strip()
        if text:
            texts.append(text)
        segment = {
            "index": index,
            "text": text,
            "raw_text": raw_text,
        }
        for key in ("language", "start", "end", "emotion", "event"):
            if key in item:
                segment[key] = item[key]
        segments.append(segment)

    payload = {
        "id": f"sensevoice-{Path(args.input).stem}",
        "provider": "sensevoice",
        "model": args.model,
        "device": args.device,
        "language": args.language,
        "use_itn": args.use_itn,
        "text": "\n".join(texts),
        "segments": segments,
        "raw": result,
    }
    progress(95, "WRITE_OUTPUT", f"Writing transcript JSON to {args.output}")
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    progress(100, "DONE", "SenseVoice transcription output written")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        progress(100, "ERROR", str(error))
        raise

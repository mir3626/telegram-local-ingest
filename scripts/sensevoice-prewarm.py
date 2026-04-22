#!/usr/bin/env python3
import argparse
import json
import os
import sys


def progress(stage: str, message: str) -> None:
    print(
        json.dumps(
            {
                "type": "sensevoice_prewarm",
                "stage": stage,
                "message": message,
            },
            ensure_ascii=False,
        ),
        file=sys.stderr,
        flush=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and load SenseVoice models before first live job.")
    parser.add_argument("--model", default="iic/SenseVoiceSmall")
    parser.add_argument("--vad-model", default="fsmn-vad")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--max-single-segment-time-ms", type=int, default=30000)
    args = parser.parse_args()

    torch_threads = os.environ.get("TORCH_NUM_THREADS")
    if torch_threads:
        try:
            progress("THREADS", f"Setting torch CPU threads to {torch_threads}")
            import torch

            torch.set_num_threads(int(torch_threads))
        except Exception:
            pass

    progress("IMPORT", "Importing FunASR")
    from funasr import AutoModel

    model_kwargs = {
        "model": args.model,
        "device": args.device,
    }
    if args.vad_model:
        model_kwargs["vad_model"] = args.vad_model
        model_kwargs["vad_kwargs"] = {"max_single_segment_time": args.max_single_segment_time_ms}

    progress("MODEL_LOAD", f"Loading {args.model} on {args.device}")
    AutoModel(**model_kwargs)
    progress("DONE", "SenseVoice model cache is ready")


if __name__ == "__main__":
    main()

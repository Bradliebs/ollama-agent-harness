#!/usr/bin/env python
"""Bridge script: pywhispercpp transcription for the harness.

Reads a WAV file path from argv[1], prints the transcription to stdout.
The model is loaded once per call; for production swap to a long-running
subprocess that streams jobs over stdin.

Usage:
    python scripts/jarvis_whisper.py path/to/audio.wav
"""

import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: jarvis_whisper.py <wav-file>\n")
        return 2

    wav_path = sys.argv[1]
    if not os.path.isfile(wav_path):
        sys.stderr.write(f"file not found: {wav_path}\n")
        return 2

    try:
        from pywhispercpp.model import Model
    except ImportError as exc:
        # Print enough context to diagnose "works in shell, fails in server"
        # cases caused by Microsoft Store Python sandboxing or PATH ordering.
        sys.stderr.write(
            "pywhispercpp not installed for "
            + sys.executable
            + " (error: " + str(exc) + "). "
            + "site-packages: " + ";".join(sys.path[:4])
            + ". Run: " + sys.executable + " -m pip install pywhispercpp\n"
        )
        return 3

    # Model name: 'base.en' for English, 'base' for multilingual, 'small.en'
    # for higher quality. The model auto-downloads on first use to
    # %USERPROFILE%/.cache/whisper or similar.
    model_name = os.environ.get("HARNESS_WHISPER_MODEL_NAME", "base.en")

    try:
        model = Model(model_name, n_threads=os.cpu_count() or 4, print_realtime=False, print_progress=False)
        segments = model.transcribe(wav_path)
        text = " ".join(seg.text.strip() for seg in segments).strip()
        sys.stdout.write(text)
        return 0
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"transcription failed: {exc}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())

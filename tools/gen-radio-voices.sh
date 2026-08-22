#!/bin/sh
# gen-radio-voices.sh — regenerate every pre-rendered radio voice line.
#
# One command rebuilds the whole bundle in client/assets/radio/:
#
#     sh tools/gen-radio-voices.sh
#
# Adding a phrase later: edit client/src/game/phrases.ts (the bank is the
# single source of truth — this script compiles and imports it), rerun this
# script, and commit the new OGGs. The client/test/radio.test.ts bank↔bundle
# test fails until you do.
#
# Voice: Piper TTS (https://github.com/OHF-Voice/piper1-gpl, GPL-3 engine —
# build-time tool only, nothing of it ships) with the en_US-joe-medium model.
# Model card (https://huggingface.co/rhasspy/piper-voices → en/en_US/joe):
# dataset "joe", license CC0. The rendered audio is processed through the
# "hard" military-radio chain calibrated by ear against the (non-shipped)
# references in tools/radio-reference/ — see gen-radio-voices.mjs.
#
# Deps: python3 (venv-capable), ffmpeg (with libvorbis), node >= 20.
# Everything heavy is cached under tools/.cache/ (git-ignored): the piper
# venv, the voice model, and the compiled phrase bank. First run downloads
# ~60 MB; later runs are offline.
set -eu
cd "$(dirname "$0")/.."

CACHE=tools/.cache
VENV="$CACHE/piper-venv"
VOICES="$CACHE/voices"
MODEL=en_US-joe-medium

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

if [ ! -x "$VENV/bin/piper" ]; then
  echo "-- creating piper venv ($VENV)"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet piper-tts==1.7.0
  # piper-tts 1.7.0 quirk: its bundled espeak-ng looks for its data at
  # <venv>/lib/python3.*/phontab instead of the packaged espeak-ng-data/.
  # Symlink the data where the library actually looks.
  for libdir in "$VENV"/lib/python3.*; do
    data=$(echo "$libdir"/site-packages/piper/espeak-ng-data)
    [ -d "$data" ] && ln -sf "$data"/* "$libdir/"
  done
fi

if [ ! -f "$VOICES/$MODEL.onnx" ]; then
  echo "-- downloading voice model $MODEL"
  mkdir -p "$VOICES"
  "$VENV/bin/python" -m piper.download_voices --download-dir "$VOICES" "$MODEL"
fi

exec node tools/gen-radio-voices.mjs

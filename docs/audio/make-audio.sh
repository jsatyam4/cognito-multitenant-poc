#!/bin/bash
# Turns narration.txt into an audio file using macOS's built-in text-to-speech.
# Runs only on your Mac, offline. Makes no AWS or network calls.
#
#   bash docs/audio/make-audio.sh                 # default voice
#   VOICE="Ava (Premium)" bash docs/audio/make-audio.sh
#
# Better voices: System Settings → Accessibility → Spoken Content → System voice
# → Manage Voices… → download e.g. "Ava (Premium)", "Zoe (Premium)" or "Evan (Enhanced)".
set -euo pipefail
cd "$(dirname "$0")"

VOICE="${VOICE:-}"
RATE="${RATE:-180}"   # words per minute

if [ -z "$VOICE" ]; then
  for v in "Ava (Premium)" "Zoe (Premium)" "Ava (Enhanced)" "Evan (Enhanced)" "Samantha"; do
    if say -v '?' | grep -q "^$v "; then VOICE="$v"; break; fi
  done
fi

echo "Voice: ${VOICE:-system default}   Rate: $RATE wpm"
if [ -n "$VOICE" ]; then
  say -v "$VOICE" -r "$RATE" -f narration.txt -o cognito-poc-walkthrough.aiff
else
  say -r "$RATE" -f narration.txt -o cognito-poc-walkthrough.aiff
fi
afconvert -f m4af -d aac -b 96000 cognito-poc-walkthrough.aiff cognito-poc-walkthrough.m4a
rm cognito-poc-walkthrough.aiff
echo "Done → $(pwd)/cognito-poc-walkthrough.m4a"

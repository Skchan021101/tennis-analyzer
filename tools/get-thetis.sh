#!/usr/bin/env bash
# Download THETIS tennis clips and convert them to MP4 so Stroke Match can
# import them ("Pro library" > "Import a folder").
#
# THETIS: https://github.com/THETIS-dataset/dataset (research dataset; cite the
# authors, and check with them before any commercial use).
# Players p32-p55 are the experienced ones; p1-p31 are beginners.
#
# Needs: git and ffmpeg. On Windows, run it in Git Bash with ffmpeg installed.
#
# Usage: tools/get-thetis.sh [output-folder] [players] [takes]
#   output-folder  default: thetis-mp4
#   players        default: 32-55 (experts only)
#   takes          default: 1     (each player has up to 3 takes per shot: 1-3)
#
# Example: tools/get-thetis.sh thetis-mp4 40-55 1-2

set -euo pipefail

OUT="${1:-thetis-mp4}"
PLAYERS="${2:-32-55}"
TAKES="${3:-1}"
REPO=https://github.com/THETIS-dataset/dataset

for tool in git ffmpeg; do
  command -v "$tool" >/dev/null || { echo "Please install $tool first." >&2; exit 1; }
done

range() { # "32-55" -> 32 33 ... 55 ; "1" -> 1
  local a="${1%-*}" b="${1#*-}"
  seq "$a" "$b"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Listing the dataset…"
git clone -q --filter=blob:none --no-checkout --depth 1 "$REPO" "$WORK/thetis"
cd "$WORK/thetis"

# Build the list of wanted files. Forehand slice is skipped: Stroke Match
# doesn't analyze it.
wanted="$WORK/wanted.txt"
: > "$wanted"
git ls-tree -r --name-only HEAD VIDEO_RGB/ | grep -v '/forehand_slice/' | while read -r f; do
  name="$(basename "$f" .avi)"           # e.g. p40_foreflat_s1
  p="${name%%_*}"; p="${p#p}"; p="${p#P}"
  s="${name##*_s}"
  for want in $(range "$PLAYERS"); do
    [ "$p" = "$want" ] || continue
    for take in $(range "$TAKES"); do [ "$s" = "$take" ] && echo "$f" >> "$wanted"; done
  done
done

total=$(wc -l < "$wanted" | tr -d ' ')
echo "Downloading and converting $total clips into $OUT/ …"
cd - >/dev/null
mkdir -p "$OUT"
i=0
while read -r f; do
  i=$((i + 1))
  shot="$(basename "$(dirname "$f")")"
  name="$(basename "$f" .avi)"
  dest="$OUT/$shot/$name.mp4"
  [ -s "$dest" ] && continue
  mkdir -p "$OUT/$shot"
  printf '\r[%d/%d] %s/%s        ' "$i" "$total" "$shot" "$name"
  git -C "$WORK/thetis" show "HEAD:$f" > "$WORK/in.avi" < /dev/null
  ffmpeg -nostdin -loglevel error -y -i "$WORK/in.avi" -c:v libx264 -pix_fmt yuv420p -crf 23 -an -movflags +faststart "$dest"
done < "$wanted"
echo
echo "Done. In Stroke Match: Pro library > Shot: Auto-detect > Camera angle: Front > Import a folder > choose $OUT"

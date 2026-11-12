#!/usr/bin/env bash
set -euo pipefail

web_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source_texture="$web_root/assets/earth-texture-source.jpg"
output_tiles="$web_root/public/earth/tiles"
tile_size=512
maximum_level=2
total_tiles=0

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick 7 (magick) is required to generate the local earth tiles." >&2
  exit 1
fi

if [[ ! -f "$source_texture" ]]; then
  echo "NASA source texture not found: $source_texture" >&2
  exit 1
fi

temporary_root="$(mktemp -d)"
trap 'rm -rf -- "$temporary_root"' EXIT
rm -rf -- "$output_tiles"

for ((level = 0; level <= maximum_level; level += 1)); do
  x_tiles=$((2 << level))
  y_tiles=$((1 << level))
  total_tiles=$((total_tiles + x_tiles * y_tiles))
  mosaic_width=$((x_tiles * tile_size))
  mosaic_height=$((y_tiles * tile_size))
  mosaic_path="$temporary_root/level-$level.png"
  tile_work="$temporary_root/tiles-$level"

  mkdir -p -- "$tile_work"
  magick "$source_texture" \
    -filter Lanczos \
    -resize "${mosaic_width}x${mosaic_height}!" \
    "$mosaic_path"
  magick "$mosaic_path" \
    -crop "${tile_size}x${tile_size}" \
    +repage \
    -strip \
    -quality 88 \
    "$tile_work/%d.jpg"

  for ((y = 0; y < y_tiles; y += 1)); do
    for ((x = 0; x < x_tiles; x += 1)); do
      tile_index=$((y * x_tiles + x))
      output_tile_directory="$output_tiles/$level/$x"
      mkdir -p -- "$output_tile_directory"
      mv -- "$tile_work/$tile_index.jpg" "$output_tile_directory/$y.jpg"
    done
  done
done

echo "Generated $total_tiles geographic tiles across levels 0-$maximum_level in $output_tiles"

#!/usr/bin/env bash
set -euo pipefail
#
# Installs the system libraries that Playwright's Chromium needs on a minimal Ubuntu, without
# root. The base WSL image lacks libnspr4, libnss3 and libasound2, which makes browser tests fail
# with "error while loading shared libraries".
#
# Usage: bash scripts/install-chromium-deps.sh
# Then:  export LD_LIBRARY_PATH="$HOME/.local/lib/playwright-libs/lib"
#        npm run test:e2e

LIBDIR="${LIBDIR:-$HOME/.local/lib/playwright-libs}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== downloading packages into a temp dir (no root needed) =="
cd "$WORK"
for pkg in libnspr4 libnss3 libasound2t64; do
  if ! apt-get download "$pkg" >/dev/null 2>&1; then
    echo "  note: $pkg not available under that name, trying libasound2"
    apt-get download libasound2 >/dev/null 2>&1 || true
  fi
done
ls -1 ./*.deb 2>/dev/null | sed 's/^/  found /' || { echo "no packages downloaded"; exit 1; }

echo "== extracting into $LIBDIR =="
rm -rf "$LIBDIR"
mkdir -p "$LIBDIR/lib"
for deb in ./*.deb; do
  dpkg -x "$deb" "$LIBDIR/root"
done
find "$LIBDIR/root" -name '*.so*' -type f -exec cp -a {} "$LIBDIR/lib/" \;

# The runtime package ships libasound.so.2.0.0 but the soname libasound.so.2 lives in the -dev
# package, so the link the loader looks for has to be created by hand.
for f in "$LIBDIR"/lib/*.so.*; do
  base="$(basename "$f")"
  soname="$(printf '%s' "$base" | sed -E 's/^(lib.*\.so\.[0-9]+)\..*/\1/')"
  if [ "$soname" != "$base" ] && [ ! -e "$LIBDIR/lib/$soname" ]; then
    ln -s "$base" "$LIBDIR/lib/$soname"
    echo "  linked $soname -> $base"
  fi
done

echo "== verifying against the installed Chromium =="
CHROME="$HOME/.cache/ms-playwright/chromium_headless_shell-"*/chrome-headless-shell-linux64/chrome-headless-shell
if ls $CHROME >/dev/null 2>&1; then
  # grep exits 1 when nothing is missing, which is the success case, so it must not abort the run.
  missing="$(LD_LIBRARY_PATH="$LIBDIR/lib" ldd "$(ls -1 $CHROME | head -1)" 2>/dev/null | grep 'not found' | awk '{print $1}' | sort -u || true)"
  if [ -z "$missing" ]; then
    echo "  all shared libraries resolve"
  else
    echo "  still missing: $missing"
    exit 1
  fi
else
  echo "  Chromium is not installed yet; run: npx playwright install chromium"
fi

cat <<EOF

Done. Export this before running the browser tests:

  export LD_LIBRARY_PATH="$LIBDIR/lib"
  npm run test:e2e

EOF

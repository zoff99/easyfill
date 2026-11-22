#!/usr/bin/env bash
#
# EasyFill - source safety audit. Plain bash + grep/find/sed, no dependencies.
#
# Proves from the source alone that the extension:
#   1. loads no external resources (no remote css/js/html/fonts/images, no iframes)
#   2. has no internet access: no network APIs, no remote endpoints anywhere
#   3. sends no data out: no beacons, no form submits, no native messaging,
#      no remote navigation, no dynamic code loading
#   4. touches only local browser APIs (storage / menus / tabs / runtime)
#   5. references only local files, and every referenced file exists
#   6. contains no hidden characters (printable ASCII + line breaks only)
#
# Scope: the files the browser actually loads (manifest.json, src/, icons/*.svg)
# plus the repo-top README.md and LICENSE for the character scan. Dev-only
# tests/ and tools/ are not loaded by the browser and are excluded.
#
# Run:  bash tools/audit.sh        exit 0 = every check passed, 1 = violation
#
set -u
ROOT=$(cd "$(dirname "$0")/../easyfill/" && pwd)
cd "$ROOT" || exit 2
FAIL=0

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAIL=1; }
sect() { printf '\n== %s ==\n' "$1"; }

mapfile -t FILES < <(find manifest.json src icons -type f ! -name '*.png' | sort)
mapfile -t JS    < <(printf '%s\n' "${FILES[@]}" | grep '\.js$')
mapfile -t HTML  < <(printf '%s\n' "${FILES[@]}" | grep '\.html$')
mapfile -t CSS   < <(printf '%s\n' "${FILES[@]}" | grep '\.css$')
CHARFILES=("${FILES[@]}" ../README.md ../LICENSE)
printf 'EasyFill source audit - %s\n' "$ROOT"
printf 'scanning %s browser-loaded files (+ repo-top README.md/LICENSE for characters)\n' "${#FILES[@]}"

sect "1. no remote endpoints in any loaded file"
# XML namespace URIs (xmlns=...) are identifiers, never fetched - strip them
# before scanning so a real remote URL on the same line is still caught.
HITS=$(for f in "${FILES[@]}"; do
  sed -E 's/xmlns(:[a-zA-Z0-9-]+)?="[^"]*"//g' "$f" | grep -nEi '(https?|wss?|ftp|file|chrome|moz-extension|resource|data|blob)://' | sed "s|^|$f:|"
done || true)
if [ -n "$HITS" ]; then fail "URL scheme found:"; printf '%s\n' "$HITS"; else pass "no URL schemes (http/https/ws/wss/ftp/file/data/blob/chrome/resource) in manifest, src, icons (SVG xmlns identifiers exempt)"; fi
HITS=$(grep -nE '"update_url"' manifest.json || true)
if [ -n "$HITS" ]; then fail "remote update_url in manifest"; else pass "no update_url (nothing to phone home to for updates)"; fi

sect "2. no network / exfiltration / dynamic-code APIs in JavaScript"
NET='fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|RTCPeerConnection|createDataChannel|connectNative|sendNativeMessage|serviceWorker|new[[:space:]]+Image\(|eval\(|new[[:space:]]+Function\(|import\(|\$\.ajax|axios|\.submit\(|requestSubmit\(|window\.open\(|location\.(assign|replace)\(|location\.href[[:space:]]*=|createElement\(["'\''](script|iframe|frame|link|img|object|embed)["'\'']\)'
HITS=$(grep -nE "$NET" "${JS[@]}" || true)
if [ -n "$HITS" ]; then fail "network/exfil/dynamic-code API found:"; printf '%s\n' "$HITS"; else pass "no fetch/XHR/WebSocket/EventSource/beacon/submit/native-messaging/eval/dynamic-import/remote-element creation"; fi
# .src= / .href= assignments are only allowed for local blob downloads or '#'
HITS=$(grep -nE '\.(src|href)[[:space:]]*=' "${JS[@]}" || true)
BAD=$(printf '%s\n' "$HITS" | grep -vE 'createObjectURL|=[[:space:]]*["'\'']#' | grep -v '^$' || true)
if [ -n "$BAD" ]; then fail "resource assignment to non-local target:"; printf '%s\n' "$BAD"; else pass "every .src/.href assignment is a local blob download or '#' (${HITS:+$(printf '%s\n' "$HITS" | wc -l)} reviewed, 0 remote)"; fi

sect "3. HTML loads nothing external"
HITS=$(grep -nEi '<(iframe|frame|object|embed|base)[[:space:]>]' "${HTML[@]}" || true)
if [ -n "$HITS" ]; then fail "embedding tag found:"; printf '%s\n' "$HITS"; else pass "no iframe/frame/object/embed/base tags"; fi
HITS=$(grep -nEi '(src|href|poster|action|srcset)[[:space:]]*=[[:space:]]*["'\'']([a-zA-Z][a-zA-Z0-9+.-]*:|//)' "${HTML[@]}" || true)
if [ -n "$HITS" ]; then fail "external/schemed src/href in HTML:"; printf '%s\n' "$HITS"; else pass "all HTML src/href are relative local paths or '#'"; fi
MISSING=0
while IFS= read -r f; do
  d=$(dirname "$f")
  REFS=$(grep -oE '(src|href)="[^"]+"' "$f" | sed -E 's/^(src|href)="//; s/"$//' | grep -vE '^(#|[a-zA-Z][a-zA-Z0-9+.-]*:|//)' || true)
  for r in $REFS; do
    if [ ! -f "$d/$r" ]; then fail "HTML references missing file: $f -> $r"; MISSING=1; fi
  done
done < <(printf '%s\n' "${HTML[@]}")
[ "$MISSING" = 0 ] && pass "every local file referenced by HTML exists on disk"

sect "4. CSS loads nothing external"
HITS=$(grep -nEi 'url\(|@import|@font-face|image-set\(' "${CSS[@]}" || true)
if [ -n "$HITS" ]; then fail "external CSS reference found:"; printf '%s\n' "$HITS"; else pass "no url()/@import/@font-face/image-set() - styles are self-contained"; fi

sect "5. manifest references only existing local files; permissions are local-only"
MISSING=0
REFS=$(grep -oE '"(src|icons)/[^"]+"' manifest.json | tr -d '"')
for r in $REFS; do
  if [ ! -f "$r" ]; then fail "manifest references missing file: $r"; MISSING=1; fi
done
[ "$MISSING" = 0 ] && pass "all manifest file references exist ($(printf '%s\n' "$REFS" | wc -l) checked)"
PERMS=$(sed -n '/"permissions"/,/\]/p' manifest.json | grep -oE '"[^"]+"' | tr -d '"' | grep -v '^permissions$')
printf '  permissions declared: %s\n' "$(printf '%s ' $PERMS)"
BADPERM=$(printf '%s\n' "$PERMS" | grep -xE 'webRequest|webRequestBlocking|proxy|dns|nativeMessaging|downloads|geolocation|privacy|management|devtools' || true)
if [ -n "$BADPERM" ]; then fail "network-capable permission: $BADPERM"; else pass "no network-capable permissions (no webRequest/proxy/dns/nativeMessaging/downloads)"; fi

sect "6. only local browser APIs are used"
APIS=$(grep -ohE '\bbrowser\.[a-zA-Z]+' "${JS[@]}" | sort -u)
printf '  browser APIs used: %s\n' "$(printf '%s ' $APIS)"
BADAPI=0
for a in $APIS; do
  case "$a" in
    browser.storage|browser.menus|browser.tabs|browser.runtime) ;;
    *) fail "unexpected browser API namespace: $a"; BADAPI=1 ;;
  esac
done
[ "$BADAPI" = 0 ] && pass "only storage/menus/tabs/runtime - all local, none can reach the network"

sect "7. no hidden characters (printable ASCII + line breaks only)"
# README.md and LICENSE live in the repo top dir, one level above easyfill/.
# Fail loudly if a scan target is missing so the scan can never silently skip it.
for f in ../README.md ../LICENSE; do
  if [ ! -f "$f" ]; then fail "character-scan target missing: $f"; fi
done
HITS=$(LC_ALL=C grep -n '[^ -~]' "${CHARFILES[@]}" || true)
if [ -n "$HITS" ]; then fail "non-printable-ASCII byte found:"; printf '%s\n' "$HITS"; else pass "all scanned files (incl. repo-top README.md/LICENSE) are plain printable ASCII (no unicode, no zero-width, no BOM, no control chars)"; fi

printf '\n========================================\n'
if [ "$FAIL" = 0 ]; then
  printf 'AUDIT PASSED: no external loads, no internet access, no data sent out.\n'
  exit 0
else
  printf 'AUDIT FAILED: see FAIL lines above.\n'
  exit 1
fi

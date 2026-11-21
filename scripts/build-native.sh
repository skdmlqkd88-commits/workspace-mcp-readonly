#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ "$(/usr/bin/uname -s)" != Darwin || "$(/usr/bin/uname -m)" != arm64 ]]; then
    printf '%s\n' 'The read-only helper requires macOS on Apple Silicon.' >&2
    exit 1
fi

mkdir -p dist
build_dir="$(/usr/bin/mktemp -d dist/.native-build.XXXXXXXX)"
cleanup() {
    for part in workspace-fs-helper helper.sha256; do
        if [[ -e "$build_dir/$part" ]]; then
            /usr/bin/unlink "$build_dir/$part"
        fi
    done
    /bin/rmdir "$build_dir"
}
trap cleanup EXIT
/usr/bin/clang -arch arm64 -std=c17 -O2 -Wall -Wextra -Werror -pthread \
    native/workspace-fs-helper.c -o "$build_dir/workspace-fs-helper"
/bin/chmod 0755 "$build_dir/workspace-fs-helper"
/usr/bin/shasum -a 256 "$build_dir/workspace-fs-helper" | /usr/bin/cut -d ' ' -f 1 > "$build_dir/helper.sha256"
/bin/chmod 0644 "$build_dir/helper.sha256"
/bin/mv -f "$build_dir/workspace-fs-helper" dist/workspace-fs-helper
/bin/mv -f "$build_dir/helper.sha256" dist/helper.sha256

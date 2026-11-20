#!/usr/bin/env bash
# dist/ を gh-pages ブランチへ置く（GitHub Pages の「Deploy from a branch」用）。
# 使い方: npm run build のあとで bash scripts/deploy/gh-pages.sh
# gh-pages ブランチの履歴は残し、上に1コミット積む（強制プッシュはしない）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/dist"
[ -f "$DIST/index.html" ] || { echo "dist/index.html がありません。先に npm run build を実行してください。" >&2; exit 1; }
SRC_COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
WORK="$(mktemp -d)"
trap 'git -C "$ROOT" worktree remove --force "$WORK" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
if git -C "$ROOT" fetch -q origin gh-pages 2>/dev/null; then
  git -C "$ROOT" worktree add -q --detach "$WORK" FETCH_HEAD
else
  git -C "$ROOT" worktree add -q --detach "$WORK" HEAD
  git -C "$WORK" checkout -q --orphan gh-pages
  git -C "$WORK" rm -rfq . >/dev/null 2>&1 || true
fi
find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$DIST"/. "$WORK"/
touch "$WORK/.nojekyll"
git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then echo "変更はありません。"; exit 0; fi
git -C "$WORK" commit -q -m "公開用ビルド（$SRC_COMMIT）"
git -C "$WORK" push -q origin HEAD:refs/heads/gh-pages
echo "gh-pages を更新しました（元のコミット $SRC_COMMIT）。"

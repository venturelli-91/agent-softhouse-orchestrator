#!/usr/bin/env bash
# Looks for keys/tokens and personal paths in the tree and history of orchestrator/. Run before any push.
# Terms that must not leak (client, company, folder): PERSONAL_TERMS='a|b' bash scripts/check-secrets.sh
cd "$(dirname "$0")/.." || exit 2
KEYS='sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|(API_KEY|TOKEN|SECRET|PASSWORD)=[^ <$"]{12,}'
PERSONAL='[A-Za-z]:[\]Users[\]|/Users/[a-z]+/|/home/[a-z]+/'
[ -n "$PERSONAL_TERMS" ] && PERSONAL="$PERSONAL|$PERSONAL_TERMS"
EXCLUDE=(':!scripts/check-secrets.sh' ':!LICENSE' ':!package-lock.json')
failed=0
for pattern in "$KEYS" "$PERSONAL"; do
  # tree (tracked + not ignored) and history
  if git grep --untracked -nIiE "$pattern" -- . "${EXCLUDE[@]}" ; then failed=1; fi
  if git log --all -p -i -G"$pattern" --format='commit %h' -- . "${EXCLUDE[@]}" | grep -iE "^(commit |\+.*($pattern))" | grep -B1 -iE "^\+" ; then failed=1; fi
done
[ -f .env ] && git ls-files --error-unmatch .env >/dev/null 2>&1 && { echo ".env tracked by git"; failed=1; }
[ "$failed" = 0 ] && echo "ok: nothing found" || { echo "FOUND: do not publish before resolving"; exit 1; }

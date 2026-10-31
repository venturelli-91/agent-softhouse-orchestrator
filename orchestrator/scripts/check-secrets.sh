#!/usr/bin/env bash
# Procura chaves/tokens e caminhos pessoais na arvore e no historico de orchestrator/. Rode antes de qualquer push.
# Termos que nao podem vazar (cliente, empresa, pasta): TERMOS_PESSOAIS='a|b' bash scripts/check-secrets.sh
cd "$(dirname "$0")/.." || exit 2
CHAVES='sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|(API_KEY|TOKEN|SECRET|PASSWORD)=[^ <$"]{12,}'
PESSOAL='[A-Za-z]:[\]Users[\]|/Users/[a-z]+/|/home/[a-z]+/'
[ -n "$TERMOS_PESSOAIS" ] && PESSOAL="$PESSOAL|$TERMOS_PESSOAIS"
EXCLUI=(':!scripts/check-secrets.sh' ':!LICENSE' ':!package-lock.json')
falhou=0
for padrao in "$CHAVES" "$PESSOAL"; do
  # arvore (rastreados + nao ignorados) e historico
  if git grep --untracked -nIiE "$padrao" -- . "${EXCLUI[@]}" ; then falhou=1; fi
  if git log --all -p -i -G"$padrao" --format='commit %h' -- . "${EXCLUI[@]}" | grep -iE "^(commit |\+.*($padrao))" | grep -B1 -iE "^\+" ; then falhou=1; fi
done
[ -f .env ] && git ls-files --error-unmatch .env >/dev/null 2>&1 && { echo ".env rastreado pelo git"; falhou=1; }
[ "$falhou" = 0 ] && echo "ok: nada encontrado" || { echo "ENCONTRADO: nao publique antes de resolver"; exit 1; }

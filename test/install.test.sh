#!/usr/bin/env bash
# Tests for `netsignal install` / `uninstall` and the shim they write.
# Every case runs under a throwaway HOME; nothing touches the real ~/.claude.
#   bash test/install.test.sh
set -uo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

fails=0 n=0
ok()   { n=$((n + 1)); printf 'ok   %s\n' "$1"; }
fail() { n=$((n + 1)); fails=$((fails + 1)); printf 'FAIL %s\n     %s\n' "$1" "${2:-}"; }
eq()   { [[ $2 == "$3" ]] && ok "$1" || fail "$1" "want [$3], got [$2]"; }

# A fresh HOME with a copy of the real script as the plugin being installed.
new_home() {
  H=$T/home-$n-$RANDOM
  mkdir -p "$H/.claude/plugins" "$H/plugin/bin"
  cp "$REPO/bin/netsignal" "$H/plugin/bin/netsignal"
  export HOME=$H NETSIGNAL_DIR=$H/state
  unset CLAUDE_SETTINGS CLAUDE_PLUGIN_DATA
  SETTINGS=$H/.claude/settings.json
  echo '{}' > "$SETTINGS"
  REG=$H/.claude/plugins/installed_plugins.json
}

# A fake installed plugin that prints which one ran.
fake_plugin() { # fake_plugin tag -> path
  local d=$HOME/cache/$1
  mkdir -p "$d/bin"
  printf '#!/usr/bin/env bash\necho "ran:%s $*"\n' "$1" > "$d/bin/netsignal"
  chmod +x "$d/bin/netsignal"
  printf '%s' "$d"
}

# registry <key> <path> <lastUpdated> ... (repeat the triple)
registry() {
  local args=() entries='{}'
  while (( $# )); do
    entries=$(jq --arg k "$1" --arg p "$2" --arg u "$3" \
      '.[$k] = ((.[$k] // []) + [{scope:"user",installPath:$p,lastUpdated:$u}])' <<<"$entries")
    shift 3
  done
  jq -n --argjson e "$entries" '{version:2,plugins:$e}' > "$REG"
}

install() { "$HOME/plugin/bin/netsignal" install "$@" >/dev/null 2>&1; }
shim()    { "$HOME/.claude/netsignal" "$@"; }

# ---- the shim resolves the plugin under any marketplace key ----

new_home; a=$(fake_plugin old)
registry 'netsignal@claude-netsignal' "$a" 2026-01-01T00:00:00Z
install; eq "old marketplace key resolves" "$(shim hi)" "ran:old hi"

new_home; b=$(fake_plugin new)
registry 'netsignal@claude-statusbar' "$b" 2026-10-03T00:00:00Z
install; eq "renamed marketplace key resolves" "$(shim hi)" "ran:new hi"

# Marketplace rename: both keys linger, the renamed one is newer.
new_home; a=$(fake_plugin old); b=$(fake_plugin new)
registry 'netsignal@claude-netsignal' "$a" 2026-01-01T00:00:00Z \
         'netsignal@claude-statusbar' "$b" 2026-10-03T00:00:00Z
install; eq "newest lastUpdated wins (new key listed last)" "$(shim)" "ran:new "

new_home; a=$(fake_plugin old); b=$(fake_plugin new)
registry 'netsignal@claude-statusbar' "$b" 2026-10-03T00:00:00Z \
         'netsignal@claude-netsignal' "$a" 2026-01-01T00:00:00Z
install; eq "newest lastUpdated wins (new key listed first)" "$(shim)" "ran:new "

new_home; a=$(fake_plugin old); b=$(fake_plugin new)
registry 'netsignal@claude-netsignal' "$a" 2026-12-01T00:00:00Z \
         'netsignal@claude-statusbar' "$b" 2026-10-03T00:00:00Z
install; eq "newest wins even when it is the old key" "$(shim)" "ran:old "

# Marketplace removed and plugin dir deleted for the stale key: fall to the next entry.
new_home; b=$(fake_plugin new)
registry 'netsignal@claude-netsignal' "$HOME/cache/gone" 2026-12-01T00:00:00Z \
         'netsignal@claude-statusbar' "$b" 2026-10-03T00:00:00Z
install; eq "skips a newest entry whose install dir is gone" "$(shim)" "ran:new "

# Other plugins and lookalike names are ignored.
new_home; b=$(fake_plugin new); o=$(fake_plugin other)
registry 'usagebar@claude-statusbar' "$o" 2027-01-01T00:00:00Z \
         'netsignal-extras@x' "$o" 2027-01-01T00:00:00Z \
         'netsignal@claude-statusbar' "$b" 2026-10-03T00:00:00Z
install; eq "ignores other plugins" "$(shim)" "ran:new "

# No registry, or nothing usable in it: run the plugin that did the install.
new_home
install; eq "falls back to the installing plugin (no registry)" "$(shim status)" "{}"
new_home; registry 'netsignal@claude-statusbar' "$HOME/cache/gone" 2026-10-03T00:00:00Z
install; eq "falls back to the installing plugin (dead entry)" "$(shim status)" "{}"
echo 'not json' > "$REG"
eq "falls back to the installing plugin (corrupt registry)" "$(shim status)" "{}"

# The fallback path survives spaces and quotes.
new_home; mkdir -p "$HOME/it's here/bin"; cp "$REPO/bin/netsignal" "$HOME/it's here/bin/"
"$HOME/it's here/bin/netsignal" install >/dev/null 2>&1
eq "fallback root with a space and a quote" "$(shim status)" "{}"

# ---- settings.json handling ----

new_home
install
eq "plain install sets the statusLine to the shim" \
  "$(jq -r .statusLine.command "$SETTINGS")" "\"$HOME/.claude/netsignal\" statusline"

new_home
jq '.statusLine={type:"command",command:"echo hello"}' "$SETTINGS" > "$SETTINGS.t" && mv "$SETTINGS.t" "$SETTINGS"
install
eq "foreign statusLine is wrapped" "$(sed -n 's/^inner=//p' "$NETSIGNAL_DIR/config")" "echo hello"
eq "foreign statusLine is replaced by the shim" \
  "$(jq -r .statusLine.command "$SETTINGS")" "\"$HOME/.claude/netsignal\" statusline"

# A wrapper script that calls ~/.claude/netsignal must not be wrapped again (it would recurse).
for how in '~/.claude/kettle/kettle-statusline.sh' '$HOME/.claude/kettle/kettle-statusline.sh' \
           '"$HOME/.claude/kettle/kettle-statusline.sh" --x'; do
  new_home
  mkdir -p "$HOME/.claude/kettle"
  printf '#!/usr/bin/env bash\nin=$(cat)\n"$HOME/.claude/netsignal" statusline <<<"$in"\n' > "$HOME/.claude/kettle/kettle-statusline.sh"
  chmod +x "$HOME/.claude/kettle/kettle-statusline.sh"
  jq --arg c "$how" '.statusLine={type:"command",command:$c}' "$SETTINGS" > "$SETTINGS.t" && mv "$SETTINGS.t" "$SETTINGS"
  before=$(cat "$SETTINGS")
  install; eq "indirect wrapper ($how): settings untouched" "$(cat "$SETTINGS")" "$before"
  [[ ! -e $NETSIGNAL_DIR/config ]] && ok "indirect wrapper ($how): no inner recorded" || fail "indirect wrapper ($how): no inner recorded"
  [[ -x $HOME/.claude/netsignal ]] && ok "indirect wrapper ($how): shim still written" || fail "indirect wrapper ($how): shim still written"
  install --force; eq "indirect wrapper ($how): --force leaves settings alone" "$(cat "$SETTINGS")" "$before"
  "$HOME/plugin/bin/netsignal" uninstall >/dev/null 2>&1
  eq "indirect wrapper ($how): uninstall leaves settings alone" "$(cat "$SETTINGS")" "$before"
  [[ -x $HOME/.claude/netsignal ]] && ok "indirect wrapper ($how): uninstall keeps the shim" || fail "indirect wrapper ($how): uninstall keeps the shim"
done

# An unrelated script that does not mention netsignal is still wrapped.
new_home
printf '#!/usr/bin/env bash\necho plain\n' > "$HOME/plain.sh"; chmod +x "$HOME/plain.sh"
jq --arg c "$HOME/plain.sh" '.statusLine={type:"command",command:$c}' "$SETTINGS" > "$SETTINGS.t" && mv "$SETTINGS.t" "$SETTINGS"
install; eq "unrelated script is wrapped" "$(sed -n 's/^inner=//p' "$NETSIGNAL_DIR/config")" "$HOME/plain.sh"

# Re-running install repairs an old shim without --force and keeps the statusLine.
new_home; b=$(fake_plugin new)
registry 'netsignal@claude-statusbar' "$b" 2026-10-03T00:00:00Z
install
printf '#!/usr/bin/env bash\necho broken\n' > "$HOME/.claude/netsignal"
install; eq "re-install refreshes a stale shim" "$(shim)" "ran:new "
eq "re-install keeps the statusLine" \
  "$(jq -r .statusLine.command "$SETTINGS")" "\"$HOME/.claude/netsignal\" statusline"

# uninstall: restore the wrapped line, or drop ours.
new_home
jq '.statusLine={type:"command",command:"echo hello"}' "$SETTINGS" > "$SETTINGS.t" && mv "$SETTINGS.t" "$SETTINGS"
install; "$HOME/plugin/bin/netsignal" uninstall >/dev/null 2>&1
eq "uninstall restores the wrapped statusLine" "$(jq -r .statusLine.command "$SETTINGS")" "echo hello"
[[ ! -e $HOME/.claude/netsignal ]] && ok "uninstall removes the shim" || fail "uninstall removes the shim"

new_home; install; "$HOME/plugin/bin/netsignal" uninstall >/dev/null 2>&1
eq "uninstall drops our own statusLine" "$(jq -r '.statusLine // "none"' "$SETTINGS")" "none"

printf '\n%d checks, %d failed\n' "$n" "$fails"
exit $(( fails > 0 ))

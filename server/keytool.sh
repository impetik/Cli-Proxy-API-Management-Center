#!/usr/bin/env bash
# Manage per-machine API keys for CLIProxyAPI.
# Keys are plain strings with no metadata field, so the machine name is encoded
# into the key itself - that is what makes usage attributable.
#
#   keytool.sh list
#   keytool.sh add <machine-name>
#   keytool.sh remove <machine-name>
#   keytool.sh limit <machine-name> [5h=<usd>] [day=<usd>] | off   (rolling windows, API list price)
#   keytool.sh limits                                              (limits, use and blocks now)
set -euo pipefail

CONFIG=/opt/cli-proxy-api/config.yaml
QUOTAS_FILE=${QUOTAS_FILE:-/opt/cli-proxy-api/quotas.json}
BASE="http://$(python3 -c "
import re,sys
t=open('$CONFIG').read()
h=re.search(r'^\s*host:\s*\"?([^\"\n]*)\"?',t,re.M).group(1) or '127.0.0.1'
p=re.search(r'^\s*port:\s*(\d+)',t,re.M).group(1)
print(f'{h}:{p}')")"
MGMT="${CLIPROXY_MGMT_KEY:-$(cat /root/.cliproxy-mgmt-key 2>/dev/null)}"
[ -z "$MGMT" ] && { echo "no management key: set CLIPROXY_MGMT_KEY or populate /root/.cliproxy-mgmt-key" >&2; exit 1; }

api() { curl -s -m 15 -H "Authorization: Bearer $MGMT" "$@"; }

get_keys() { api "$BASE/v0/management/api-keys" | python3 -c "import json,sys; print('\n'.join(json.load(sys.stdin)['api-keys']))"; }

put_keys() { # reads keys on stdin, one per line
  python3 -c "import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))" \
  | api -X PUT -H 'content-type: application/json' -d @- "$BASE/v0/management/api-keys" >/dev/null
}

case "${1:-}" in
  list)
    printf '%-22s %s\n' "MACHINE" "KEY"
    printf '%-22s %s\n' "----------------------" "---"
    get_keys | while read -r k; do
      m=$(echo "$k" | sed -E 's/^cpx-([a-z0-9-]+)-[0-9a-f]{32}$/\1/'); [ "$m" = "$k" ] && m="(unlabelled)"
      printf '%-22s %s\n' "$m" "$k"
    done
    ;;
  add)
    [ -z "${2:-}" ] && { echo "usage: keytool.sh add <machine-name>"; exit 1; }
    name=$(echo "$2" | tr '[:upper:] _' '[:lower:]--' | tr -cd 'a-z0-9-')
    newkey="cpx-${name}-$(openssl rand -hex 16)"
    { get_keys; echo "$newkey"; } | put_keys
    echo "added key for '${name}':"
    echo "  $newkey"
    ;;
  remove)
    [ -z "${2:-}" ] && { echo "usage: keytool.sh remove <machine-name>"; exit 1; }
    get_keys | grep -v "^cpx-${2}-" | put_keys
    echo "removed keys for '${2}'"
    ;;
  limit)
    [ -z "${2:-}" ] && { echo "usage: keytool.sh limit <machine> [5h=<usd>] [day=<usd>] | off"; exit 1; }
    umask 077
    python3 - "$QUOTAS_FILE" "${@:2}" <<'EOF'
import json, os, re, sys
path, name, *args = sys.argv[1:]
try: q = json.load(open(path))
except FileNotFoundError: q = {}
lim = {}
for a in ([] if args == ["off"] else args):
    m = re.fullmatch(r"(5h|day)=(\d+(?:\.\d+)?)", a)
    if not m or float(m[2]) <= 0: sys.exit(f"bad limit '{a}': use 5h=<usd> and/or day=<usd>, above 0, or off")
    lim[m[1]] = float(m[2]) if "." in m[2] else int(m[2])
if not lim and args != ["off"]: sys.exit("give 5h=<usd> and/or day=<usd>, or off")
if lim: q[name] = lim
else: q.pop(name, None)
with open(path + ".tmp", "w") as f: json.dump(q, f, indent=1)
os.replace(path + ".tmp", path)
print(f"{name}: " + (", ".join(f"{w} ${v}" for w, v in lim.items()) if lim else "no limit"), "(applies within ~20 s)")
EOF
    ;;
  limits)
    host=$(echo "$BASE" | sed -E 's#^http://([^:]+):.*#\1#')
    { echo "KEY 5H_USED/LIMIT DAY_USED/LIMIT BLOCKED_UNTIL_UTC"
      api "http://$host:8318/usage/quotas" | jq -r '.keys | to_entries[] | .value as $v | [.key,
        ("5h", "day" | "$\($v.used[.] * 100 | round / 100)/\($v.limits[.] // "-")"),
        ($v.blocked_until // "-" | .[:16])] | @tsv'; } | column -t
    ;;
  *) echo "usage: keytool.sh {list|add <machine>|remove <machine>|limit <machine> [5h=<usd>] [day=<usd>]|off|limits}"; exit 1 ;;
esac

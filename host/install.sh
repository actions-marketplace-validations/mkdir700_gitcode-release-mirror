#!/bin/sh
# One-time (and per-upgrade) installation of the SSH host side. Run it as root
# from a checkout or release archive of this repository:
#
#   sh host/install.sh [--prefix /opt/gitcode-release-mirror] [--config-dir /etc/gitcode-release-mirror]
#
# It copies the two files that the forced command runs, read-only, and creates a
# config file from the example when none exists. It does not create accounts,
# edit sshd_config or touch authorized_keys; docs/host-setup.md lists those steps.
set -eu

prefix=/opt/gitcode-release-mirror
config_dir=/etc/gitcode-release-mirror
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix=${2:?--prefix needs a directory}; shift 2 ;;
    --config-dir) config_dir=${2:?--config-dir needs a directory}; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
for file in "$repo/lib/host.mjs" "$repo/lib/mirror-core.mjs" "$here/config.example.json"; do
  [ -f "$file" ] || { echo "missing $file; run this from a complete checkout" >&2; exit 1; }
done

install -d -m 755 "$prefix" "$config_dir"
install -m 444 "$repo/lib/host.mjs" "$prefix/host.mjs"
install -m 444 "$repo/lib/mirror-core.mjs" "$prefix/mirror-core.mjs"
if [ ! -e "$config_dir/config.json" ]; then
  install -m 444 "$here/config.example.json" "$config_dir/config.json"
  echo "created $config_dir/config.json from the example; edit it before use"
fi
if [ "$(id -u)" = 0 ]; then
  chown root "$prefix" "$prefix/host.mjs" "$prefix/mirror-core.mjs" "$config_dir" "$config_dir/config.json"
  chmod 755 "$prefix" "$config_dir"
else
  echo "not running as root: files keep your ownership, which is fine for a local trial only" >&2
fi

node_bin=$(command -v node || echo /path/to/node)
echo "installed to $prefix"
echo "mirror-core.mjs sha256: $(shasum -a 256 "$prefix/mirror-core.mjs" 2>/dev/null | cut -d' ' -f1 || sha256sum "$prefix/mirror-core.mjs" | cut -d' ' -f1)"
echo
echo "authorized_keys line for the CI key (one line):"
echo "restrict,command=\"$node_bin $prefix/host.mjs $config_dir/config.json\" <ssh-ed25519 public key>"

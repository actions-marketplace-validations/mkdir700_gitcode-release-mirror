# Setting up the SSH host

One-time work for the administrator of the host that will upload to GitCode.
The host needs: Node.js 22 or newer (the suite ran it on v22.22.1; older
versions are untested), `sshd` with OpenSSH 7.2+ for `restrict` (older: see the
end), and outbound https to the source server and to GitCode. It does **not**
need a GitHub runner, and it never stores a GitCode credential.

## 1. Account

```sh
useradd --system --create-home --shell /bin/sh gitcode-mirror   # a shell is needed to start the forced command
passwd -l gitcode-mirror
```

Do not add the account to any group, and do not give it write access to the
installed files.

## 2. Install the files (as root)

From a checkout of the release you will pin in your workflows:

```sh
git clone https://github.com/mkdir700/gitcode-release-mirror.git
cd gitcode-release-mirror && git checkout <the same full commit SHA the workflows use>
sh host/install.sh        # --prefix /opt/gitcode-release-mirror --config-dir /etc/gitcode-release-mirror
```

This copies `host.mjs` and `mirror-core.mjs` read-only and root-owned, and creates
`/etc/gitcode-release-mirror/config.json` from an example. The script prints the
SHA-256 of the core and the `authorized_keys` line to use. Upgrading means
checking out the new release and running the script again; the Action and the
host refuse to talk to each other when the core differs.

At start the forced command checks that `host.mjs`, `mirror-core.mjs`, the
config and their directories cannot be written by the account that runs it
(`access(W_OK)` fails and the mode has no group/other write bit). On a normal
root-owned installation that holds; if you run it as root, or make the files
writable, it refuses.

## 3. Configure what the host may do

Edit `/etc/gitcode-release-mirror/config.json` (root-owned, not writable by the account):

```json
{
  "allowedRepositories": ["your-org/your-gitcode-mirror"],
  "allowedSourcePrefixes": ["https://downloads.example.com/releases/"],
  "fileNamePattern": "^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$",
  "maxFileBytes": 2147483648,
  "maxDeadlineSeconds": 7200
}
```

| Field | Meaning |
| --- | --- |
| `allowedRepositories` | GitCode `owner/repo` values a request may target. Required. |
| `allowedSourcePrefixes` | https prefixes ending in `/`. A source URL and **every redirect hop** must start with one of them. No ports, no user-info; the path is matched after normalisation and `%2f`/`%5c` are refused. Required. |
| `fileNamePattern` | Regular expression for the file name (the last URL segment). Default as shown; `..` is always refused. |
| `maxFileBytes` | Largest source accepted (default 2 GiB). |
| `maxDeadlineSeconds` | Largest `deadline` a request may ask for (default 7200). |
| `tmpDir` | Where downloads are staged (default the system temp directory). Must be writable by the account and large enough for the biggest file. |

Unknown fields are rejected. A bad config fails every request with a clear message.

## 4. Authorise the CI key

Create a key pair that is used for nothing else:

```sh
ssh-keygen -t ed25519 -N '' -C gitcode-release-mirror-ci -f ci_key
```

Put the **private** key into a GitHub secret (for the `ssh-key` input) and add to
`~gitcode-mirror/.ssh/authorized_keys` the line printed by the installer, with the
public key filled in:

```
restrict,command="/usr/bin/node /opt/gitcode-release-mirror/host.mjs /etc/gitcode-release-mirror/config.json" ssh-ed25519 AAAA... gitcode-release-mirror-ci
```

`restrict` turns off pty allocation, port, agent and X11 forwarding and
`~/.ssh/rc`; the command is the only thing the key can run. The wrapper also
rejects a connection that asked for any other command. Make `authorized_keys`
and `.ssh` owned by root or by the account with mode 600/700 as `sshd` requires.

Collect the host keys for the `ssh-known-hosts` input from a trusted network
path and compare the fingerprints with what you know about the host:

```sh
ssh-keyscan -t ed25519 -p 22 mirror.example.com   # or read /etc/ssh/ssh_host_ed25519_key.pub on the host
```

For a non-default port use the `[host]:port` form in `known_hosts`. The Action
always uses `StrictHostKeyChecking=yes` with only the keys you provide.

## 5. Try it

Run the Action once with a small file from an allowed prefix against a GitCode
repository meant for testing, then run it again: the second receipt must say
`reused` and the source server must not see a second download.

## What the host can and cannot do for the holder of the key

It can download files from the allow-listed prefixes and upload them to the
allow-listed repositories **with the token the workflow supplies**. It cannot run
other commands, read other files, change its own code or config, or use any
credential of its own (it has none). The holder of the SSH key can still cost you
bandwidth and disk space; limit that with `maxFileBytes`, the allow-list and
`MaxSessions`/`MaxStartups` in `sshd_config`. The token is sent through the
encrypted SSH channel and lives only in the memory of one process; it is masked
in everything the host prints.

## Older OpenSSH

Without `restrict`, use
`no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc,command="..."`.
This variant is not covered by the end-to-end suite.

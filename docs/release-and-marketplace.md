# Releases, pinning and the Marketplace listing

Nothing in this file has been done yet: creating the GitHub repository, tagging
and listing are external steps that need the repository owner.

## Versioning

* Semantic versions: `v1.0.0`, `v1.0.1`, ... A change to the request protocol
  (`version` in the host request), to the receipt schema or to an input is a
  major change, because the host must be redeployed in step with the Action.
* Every release must be cut from a commit where `npm run check-dist` and
  `npm run e2e` pass. The core file `lib/mirror-core.mjs` is part of the
  release: its SHA-256 appears in each receipt (`coreSha256`) and the installer
  prints it.
* Users pin the **full commit SHA** and write the version in a comment. A moving
  `v1` tag is optional convenience; do not create GitHub releases for a moving
  tag if immutable releases are enabled (the tag would no longer move).
* Dependabot/Renovate can bump the pinned SHA; an update means a new host
  install too, so the update notes must say so.

## Cutting a release

1. `npm ci && npm run build && npm run check-dist && npm run e2e`; commit the result.
2. Update the version in `package.json`; tag `vX.Y.Z` (annotated) on that commit.
3. Write the release notes: what changed, whether the core changed (so hosts
   must run `host/install.sh` again), the core SHA-256.
4. Publish the GitHub release; tick "Publish this Action to the GitHub Marketplace"
   the first time (see below).

## Marketplace material

| Field | Proposal |
| --- | --- |
| Repository | `mkdir700/gitcode-release-mirror`, public (checked 2026-10-09: no repository of that name in the organisation or in a GitHub search) |
| Action `name` | `GitCode Release Mirror` (alternative: `Mirror Release Assets to GitCode`). GitHub requires the name to be unique across Marketplace actions, users/organisations, categories and features. **Uniqueness has not been checked**; search the Marketplace before the first release. |
| Description | Mirror release assets to a GitCode Release, directly or through an SSH host in mainland China, and verify them byte for byte. (the `description` in `action.yml`; GitHub shows it in search) |
| Branding | icon `upload-cloud`, colour `blue` (Feather icon set, as the metadata page requires) |
| Categories | Primary: Deployment. Secondary: Utilities. |
| Short README summary | See the top of `README.md`. State the "Not verified" list on the listing page too. |
| Licence | MIT (`LICENSE`) |

Account prerequisites from GitHub's page: two-factor authentication on the
publishing account, acceptance of the Marketplace terms and of the Marketplace
Developer Agreement by the repository owner.

## Before the first public release

* Run the real-GitCode checks listed under "Not verified" in the README with a
  test repository and a dedicated token; replace the README wording with the
  measured facts.
* Decide the token advice (dedicated bot account with write access to the mirror
  repository only) after the scope question is answered.
* Have a second person review `lib/host.mjs`; it is the security boundary.

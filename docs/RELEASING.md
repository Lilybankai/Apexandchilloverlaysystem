# Releasing — stable and beta

Two feeds, one repo, one command.

| | Version looks like | Published as | Who receives it |
|---|---|---|---|
| **Stable** | `0.57.0` | a normal GitHub release | every install (the default) |
| **Beta** | `0.57.1-beta.1` | a GitHub **prerelease** | only installs switched to the beta channel |

The channel is **read off the version number in `package.json`**. There is no
flag to remember and no second command to get wrong: give a build a `-beta.N`
version and it publishes to beta; give it a plain `x.y.z` and it goes to
everyone.

---

## Why the prerelease flag is the whole thing

An installed app on the stable channel asks GitHub for
`/repos/…/releases/latest`. GitHub's definition of "latest" **excludes
prereleases**, so a build flagged as one is not merely unadvertised — it is
unreachable for a stable install, whatever its version number.

An install on the beta channel instead walks the full releases feed and takes
the newest entry of either kind. Two consequences worth knowing:

- **Beta testers still get stable releases.** `0.57.0` beats `0.57.0-beta.3`, so
  promoting a beta to main is a non-event for the people who were testing it —
  they move onto the release like everyone else.
- **Nothing is "moved" between channels.** Promotion is publishing a new stable
  version, not editing the beta's flag.

`scripts/publish-notes.js` reads the flag back off the published release and
repairs it if it landed wrong, because "we set the env var" is a claim about the
build script, and this is the fact itself.

---

## Cutting a beta

1. `git fetch origin` first — another builder pushes to this repo (see
   `parallel-builder-repo` in the agent memory). Decide the version **after** the
   fetch.
2. Land the work as a `feat(...)` / `fix(...)` commit that carries the code **and**
   its `CHANGELOG.md` section, headed with the beta version:

   ```markdown
   ## 0.57.1-beta.1 — 2026-08-05

   ### Added

   - **What changed, in a sentence.** Then the paragraph that says why it
     matters to someone driving.
   ```

3. Bump `package.json` to `0.57.1-beta.1` in its own `chore(release):` commit.
4. **Tag that commit and push the tag — before publishing.**

   ```bash
   git tag -a v0.57.1-beta.1 -m "0.57.1-beta.1" && git push origin v0.57.1-beta.1
   ```

   Not optional, and not cosmetic. If the tag does not already exist, GitHub
   creates it at the **default branch's HEAD** — so a release cut from an
   unmerged branch is tagged on a commit that has nothing to do with the build,
   and the release inherits *that* commit's date. An install on the beta channel
   reads `releases.atom`, which is ordered by tag date and not by version, and
   takes the first entry: a release tagged onto an older commit sorts below the
   build the tester is already running and is never offered. It is signed, it is
   flagged, its `latest.yml` is correct, and it is invisible. This is what
   happened to `v0.97.2-beta.3` on 2026-09-04.

5. Publish:

   ```bash
   GH_TOKEN=$(gh auth token) npm run release
   ```

   It prints the channel it has decided on before it does anything. Read that
   line.
6. The next beta is `-beta.2`, and so on. Each gets its own changelog section —
   that is what the beta channel's What's New sheet shows.

`npm run release:dry` builds the installer and the notes without publishing
anything, if you want to check the pipeline.

## Promoting a beta to stable

1. **Fold the beta sections into one.** Replace `## 0.57.1-beta.1`,
   `-beta.2`, … with a single `## 0.57.1 — <date>` section describing the
   release as a whole. `check-changelog.js` refuses to publish a stable version
   while any `x.y.z-beta.*` section for it still exists: drivers on stable never
   ran those builds and need the release, not a diary of how it got there.
2. Bump `package.json` to `0.57.1`.
3. `GH_TOKEN=$(gh auth token) npm run release`.

Everyone on stable is offered it at their next check; everyone on beta is too,
since it is newer than the last beta.

## Switching channels in the app

**Settings → Updates**, visible only to league staff — the same `admin:whoami`
gate as the Admin tab. It is not a security boundary (the beta releases are
public on GitHub); it keeps the five people testing the platform from being one
dropdown away from a build we are midway through breaking. The card also stays
visible to anyone *already running* a beta, so nobody can lose the control that
gets them back.

Switching to stable while running a beta turns on `allowDowngrade`, so the app
offers the newest stable release even though it is numerically older. That is
the only case where this app will ever install a lower version than it is
running.

## What a release must carry

Unchanged from before, and still true for betas: **installer + `.blockmap` +
`latest.yml`**, with hyphenated filenames. `npm run release` gets this right;
hand-uploading with `gh release upload` does not (it turns spaces into dots and
the manifest stops matching). Verify with:

```bash
gh release view v0.57.1 --json assets --jq '.assets[].name'
```

Note that a beta publishes `latest.yml`, not `beta.yml` — for the GitHub
provider, electron-builder puts the manifest under the release's own tag and the
prerelease flag does the separating.

## If something goes out on the wrong channel

```bash
# published a beta as a full release — hide it, now
gh release edit v0.57.1-beta.1 --prerelease=true --latest=false

# published a stable release flagged as a prerelease — nobody is being offered it
gh release edit v0.57.1 --prerelease=false --latest=true
```

Then check what `/releases/latest` actually resolves to:

```bash
gh release view --json tagName,isPrerelease
```

## Code signing

Windows builds are signed with **Azure Trusted Signing** (account `apex26`,
North Europe, certificate profile `ApexAIOSystem26`, subject
`CN=The Lilybank Agency Ltd`). It is configured in `electron-builder.js`, and
turns itself on only when the credentials are present:

```bash
AZURE_TENANT_ID=…      # Directory (tenant) ID
AZURE_CLIENT_ID=…      # the signing app registration
AZURE_CLIENT_SECRET=…  # its client secret — expires, see below
```

These live in `electron-builder.env`, which the electron-builder CLI loads by
itself on every run. That file is gitignored and holds a live secret. Without
it the build still succeeds and prints a warning, producing an unsigned
installer.

The service principal needs the **Artifact Signing Certificate Profile Signer**
role on the account (the portal has renamed Trusted Signing to Artifact
Signing; the role names moved with it). Assign it to the *app registration*,
not to your own user account — the build authenticates as the service
principal, and a role on a human grants it nothing. Getting this wrong gives a
`403 (Forbidden)` at sign time, after authentication has already succeeded.
Allow 15–30 minutes for a new assignment to take effect.

### Why this does not use `win.azureSignOptions`

electron-builder has built-in Trusted Signing support and it does not work
here. It builds its PowerShell command by joining arguments with spaces and
quoting none of them, so `-Files …\Apex AIO System.exe` is read as three
arguments: the file `…\Apex`, the folder `Overlay`, the filter `System.exe`.
It signs nothing and reports success at the electron-builder level. The
product name would have to lose its spaces to use that path, and it appends
the file argument after the caller's options, so it cannot be pre-quoted from
config either.

`electron-builder.js` therefore registers a custom sign hook that invokes the
same `Invoke-TrustedSigning` PowerShell module directly, with every value
quoted. `signingHashAlgorithms` is pinned to `['sha256']` because
electron-builder otherwise defaults `.exe` to `['sha1','sha256']` and calls the
hook once per algorithm.

### Timestamping is not optional

Trusted Signing certificates are valid for about **three days**. An
untimestamped signature dies with its certificate, so an installer signed on a
Wednesday would start failing signature checks that Saturday — on machines that
had already installed it, too, because electron-updater verifies signatures.
The countersignature is what makes short-lived certificates workable: verifiers
check the signing time against the certificate's validity window rather than
against today's date.

The PowerShell module declares `-TimestampRfc3161` and `-TimestampDigest` with
no defaults, so omitting them applies no timestamp at all and reports success.

### Verifying a signed build

`Get-AuthenticodeSignature` returns `Valid` for an untimestamped file, so it
cannot answer this on its own. Use signtool:

```powershell
& "$env:LOCALAPPDATA\TrustedSigning\Microsoft.Windows.SDK.BuildTools\*\bin\*\x64\signtool.exe" `
  verify /pa /v "release\win-unpacked\Apex AIO System.exe"
```

Three things have to be true:

- `Successfully verified`
- `The signature is timestamped: …` — **not** `File is not timestamped.`
- the subject's CN matches `publisherName` in `electron-builder.js` character
  for character. It is written into `latest.yml`, and electron-updater rejects
  any update whose signature disagrees with it. A mismatch does not fail the
  build; it breaks updating for every install.

### Other ways this goes quiet

- **`build` reappearing in `package.json`.** electron-builder reads that field
  in preference to `electron-builder.js` and never falls through, so the whole
  config — signing included — is ignored without comment.
- **The client secret expiring** (24 months from creation). Builds stop signing
  and carry on succeeding; the warning in the build output is the only tell.

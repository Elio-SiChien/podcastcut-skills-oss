# OSS Freeze Runbook

This runbook prepares a frozen public snapshot before the main
`luoyuweidu1/podcastcut-skills` repository is made private.

## Locked Decisions

| Decision | Value |
|---|---|
| OSS repo name | `podcastcut-skills-oss` |
| History strategy | Preserve full history only if hygiene checks pass |
| License | MIT |
| Freeze tag | `oss-freeze-2026-06-12` |
| Private repo | Keep `luoyuweidu1/podcastcut-skills` as the ongoing commercial repo |

If the freeze happens on a later calendar date, regenerate the freeze tag date
before pushing.

## Safety Rules

- Do not make the main repo private until the OSS snapshot is verified.
- Do not push runtime profiles, `.env`, cloud-bridge sessions, generated output,
  credentials, tokens, or customer-private data to the OSS repo.
- If history hygiene finds sensitive data, use a squashed clean snapshot instead
  of preserving history.
- Repo visibility changes and new repo creation are operator-owned actions.

## Preflight

From a clean clone of the current main repo:

```bash
git fetch origin main
git checkout main
git pull --ff-only origin main
npm install
npm test
npm run oss:hygiene
```

If `npm run oss:hygiene` reports `FAIL`, stop and decide whether to filter
history or publish a squashed snapshot.

## Snapshot README

For the OSS repo, replace or prepend the public README with:

```text
docs/oss-freeze/README.snapshot.md
```

Keep the full technical docs in the repo, but make the frozen/commercial split
obvious in the first screen of the OSS README.

## Preserve-History Path

Use this path only after hygiene passes.

```bash
git checkout -b oss-freeze
cp docs/oss-freeze/README.snapshot.md README.md
git add README.md LICENSE docs/oss-freeze tools/oss-hygiene-check.mjs package.json
git commit -m "Prepare frozen OSS snapshot"
git tag -a oss-freeze-2026-06-12 -m "Freeze OSS snapshot before private commercial development"

git remote add oss git@github.com:luoyuweidu1/podcastcut-skills-oss.git
git push oss oss-freeze:main
git push oss oss-freeze-2026-06-12
```

Then verify:

```bash
gh repo view luoyuweidu1/podcastcut-skills-oss --web
git ls-remote --tags oss oss-freeze-2026-06-12
```

This keeps full pre-freeze history while making the OSS repo's `main` branch
land on a final public-facing snapshot commit with the frozen README.

## Squashed Snapshot Path

Use this path if preserving history exposes private data.

```bash
TMP_DIR="$(mktemp -d)"
git archive --format=tar HEAD | tar -x -C "$TMP_DIR"
cd "$TMP_DIR"
git init
git add .
git commit -m "Freeze Podcastcut OSS snapshot"
git branch -M main
git remote add origin git@github.com:luoyuweidu1/podcastcut-skills-oss.git
git tag -a oss-freeze-2026-06-12 -m "Freeze OSS snapshot before private commercial development"
git push -u origin main
git push origin oss-freeze-2026-06-12
```

## Make Main Private

After the OSS repo is verified, the operator can make
`luoyuweidu1/podcastcut-skills` private in GitHub settings. Keep the repo name
unchanged so existing remotes, PR links, and install docs continue to work for
authorized collaborators.

## Post-Migration Follow-Ups

- Add private `profiles/<podcast>.json` files to the private main repo.
- Update `安装/install.sh` to sync private repo profiles into
  `~/.claude/skills/profiles/`.
- Update multi-computer setup docs so private main is the canonical source for
  code and profiles.

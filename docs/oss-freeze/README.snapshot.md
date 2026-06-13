# Podcastcut Skills OSS Snapshot

This repository is a frozen open-source snapshot of `podcastcut-skills`.

Commercial development has moved to a private repository. This OSS snapshot is
provided for reference, learning, and self-hosted experimentation under the MIT
License. It will not receive ongoing feature updates from the commercial branch.

## What Is Included

- Claude Code Skills for a podcast editing pipeline
- Transcription, rough-cut, fine-cut, execution, QA, audio-quality, and post-production runbooks
- Local CLI checks such as `doctor`, `status`, `validate`, `fresh-agent`, and `footer`
- Browser review page assets and cloud-bridge support code
- Regression tests that run without API keys

## What Is Not Included

- Private customer podcast profiles
- API keys or runtime `.env` files
- Runtime cloud-bridge sessions, upload state, output audio, or generated project artifacts
- Future private/commercial updates after the freeze tag

## Install

```bash
git clone https://github.com/luoyuweidu1/podcastcut-skills-oss.git
cd podcastcut-skills-oss
npm install
bash 安装/install.sh
npm run doctor
npm test
```

Real transcription requires a DashScope API key in `.env`. Runtime review pages
also require local cloud-bridge setup.

## Frozen Snapshot

Recommended tag:

```bash
oss-freeze-2026-06-12
```

The private commercial repository may continue from a later commit. Do not
expect this OSS snapshot to match future private behavior.

## License

MIT. See `LICENSE`.

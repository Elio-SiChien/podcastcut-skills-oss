#!/usr/bin/env bash
#
# spawn_podcaster_agent.sh — draft a `slock action prepare` card so the
# operator can one-click create a dedicated agent for a podcaster client.
#
# Why this exists: per Slock's admin model, agents can't create agents
# directly — admin actions stay human-committed. The action-card primitive
# is the supported channel: agent prepares the card, human clicks, dialog
# opens with prefilled values, human submits, new agent gets created under
# their identity. See dispatcher/SKILL.md and the agent-knowledge
# `action-cards` topic for the long version.
#
# usage:
#   bash spawn_podcaster_agent.sh <slug> <display_name> [target] [description]
#
#   slug          ASCII handle suffix. Final agent becomes
#                 @podcast-editor-<slug>. (Slock @mention slugs need to
#                 be ASCII in v0.)
#   display_name  Human-readable name, can be Unicode (e.g. "辟客").
#   target        slock target for the action card. Default: dm:@xiangge-li
#   description   Optional custom description. If omitted we generate a
#                 sensible default from display_name.
#
# Exit codes:
#   0 — card prepared and posted
#   2 — bad args
#   1 — slock CLI call failed
#
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: bash spawn_podcaster_agent.sh <slug> <display_name> [target] [description]" >&2
  exit 2
fi

SLUG="$1"
DISPLAY_NAME="$2"
TARGET="${3:-dm:@xiangge-li}"
DESCRIPTION="${4:-}"

# Slug sanity check — ASCII lowercase + digits + hyphens, ≤32 chars.
# Slock @mention parser is conservative; bail early before posting a
# card the human's Create-Agent dialog would reject.
if ! [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "error: slug must be lowercase a-z, 0-9, hyphen; 1-32 chars (got '$SLUG')" >&2
  exit 2
fi

AGENT_NAME="podcast-editor-${SLUG}"

if [[ -z "$DESCRIPTION" ]]; then
  DESCRIPTION="${DISPLAY_NAME} 的播客剪辑助手 — 转录、粗剪、精剪、音质、后期、出片，全流程。共享 podcastcut-skills 代码库，独立 workspace + memory。"
fi

# Build the action card JSON. Slock's action-card schema (verified live
# 2026-06-08 — the agent-knowledge `action-cards` topic uses the word
# "variant" for the discriminator but the actual JSON field name is
# `type`. Validator returns INVALID_ACTION if you send `variant`):
#   type: "agent:create"
#   name: required, the @mention handle (no @ prefix)
#   description: optional, shown in the Create Agent dialog
#   draftHint: optional, freeform note shown above the card to explain
#              why the agent drafted it
DRAFT_HINT="新建专属 agent — @${AGENT_NAME} 给 ${DISPLAY_NAME}。点 Create Agent → 选 Computer/Runtime/Model → 提交。"

PAYLOAD="$(node -e "
const obj = {
  type: 'agent:create',
  name: process.argv[1],
  description: process.argv[2],
  draftHint: process.argv[3],
};
process.stdout.write(JSON.stringify(obj));
" "$AGENT_NAME" "$DESCRIPTION" "$DRAFT_HINT")"

echo "==> posting action card to $TARGET"
echo "    proposed agent: @${AGENT_NAME}"
echo "    display name:   ${DISPLAY_NAME}"
echo ""

# Pipe the JSON on stdin per `slock action prepare` convention.
echo "$PAYLOAD" | slock action prepare --target "$TARGET"

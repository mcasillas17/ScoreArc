# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in
this repository.

The full project guide lives in AGENTS.md (single source of truth for all AI agents):

@AGENTS.md

## Critical — read first

- **`main` auto-deploys to production. Never commit or merge directly to `main`.** Branch
  for all work.
- **Test locally (`npm run dev` in the browser + `npm test` + `npx tsc --noEmit`) before
  opening a PR.** Merging is the user's call, not yours.

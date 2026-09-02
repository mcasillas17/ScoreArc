# Decision: ESPN data-rights engineering gate

- **Status:** Accepted (engineering gate)
- **Date:** 2026-09-01
- **Decision owner:** Project owner (mcasillas17), on engineering recommendation
- **Supersedes:** the informal rights note in `docs/CURRENT_STATE.md` §7, which
  this record now backs with source citations and a closure path
- **Scope:** what ScoreArc's engineering may build and ship against ESPN's
  public data while this gate is open

## What this is, and is not

This is an **engineering release gate**: a decision by the project about what
we will and will not build and ship, made because a plausible legal risk
exists and has not been resolved. It is **not legal advice**, and it is
**not** a conclusion that ScoreArc's current data collection or use is lawful
or unlawful. Only qualified counsel, or an explicit license from a rights
holder, can answer that question. This document exists so engineering has an
unambiguous, written line to build against in the meantime, and a named set
of evidence that would move the line.

## Primary source verified in this audit

**Disney Terms of Use – United States**, last updated **2024-05-24**
(<https://disneytermsofuse.com/english/>), fetched and read directly as part
of this audit. Its own text states it governs "Disney Products," defined to
include anything "branded Disney, ABC, ESPN, Marvel, Pixar, Lucasfilm, FX,
Searchlight Pictures, 20th Century Studios, National Geographic, or another
brand owned or licensed by Disney" — ESPN-branded products, including
espn.com and its API surfaces, are expressly in scope, not an inference.
ESPN's own support site points at the same document as its Terms of Use
(<https://support.espn.com/hc/en-us/articles/360035445091-Terms-of-Use>).

Relevant sections, summarized (not overquoted — read the source for exact
wording before relying on it):

| Section | What it says |
|---|---|
| **§2.A** (Consumer License) | Grants a personal, noncommercial license only, and its text expressly carves out "any use, creation, development, modification, prompting, fine-tuning, training, testing, benchmarking or validation of any artificial intelligence or machine learning tool" from that grant. AI/ML use is not a gap in the terms; it is named and excluded. |
| **§2.B.viii** | Prohibits, without express written permission, using the products "for any commercial or business-related use" or building "a business utilizing" them, whether or not for profit. |
| **§2.B.x** | Prohibits, without express written permission, accessing, monitoring, copying, or extracting the products "using a robot, spider, script, or other automated means," including for building or training an AI tool, data mining, web scraping, or otherwise "compiling, building, creating or contributing to any collection of data, data set or database." |

Taken together, the plain text reaches ScoreArc's own architecture directly:
automated collection (§2.B.x), building a persistent dataset from it
(§2.B.x), and any AI/ML use of it (§2.A, §2.B.x) are each named, not merely
arguably covered.

## Surfaces this gate maps to

| ScoreArc surface | Why it is in scope |
|---|---|
| Go ingester (automated ESPN polling) | Automated, scripted extraction — the core conduct named in §2.B.x. |
| Neon Postgres persistence | The resulting "collection of data, data set or database" §2.B.x names. |
| Private raw R2 archive (touch/play-stream bytes) | Same database-building concern, at the least-transformed data layer we keep. |
| Public crest mirror, and team/league names, marks, and identity | Separate IP question from the data-extraction terms above — team and league crests, names, and marks are third parties' trademarks/copyrights, not ESPN's to license through these terms at all. |
| Public reader (`/v1` REST API) | Redistribution of the collected data to any consumer beyond ScoreArc's own rendering. |
| News proxy, and any images/video surfaced through it | Same redistribution and automated-extraction concerns, plus separate media rights. |
| Historical backfill (`play-backfill`, season history) | Same automated-extraction and database-building concerns, at larger volume and over data ESPN did not serve live. |
| E8 (AI-generated recaps/digests/previews) | Directly named by §2.A's AI/ML carve-out — this is the clearest match in the text. |
| E9 (xG training and validation) | Same §2.A carve-out — "training, testing, benchmarking or validation" of a model is named verbatim. |
| A real-data MCP surface, and any third party it serves | Combines automated extraction, database/redistribution, and (if any generation sits in front of it) AI use — the highest-combined-risk surface, and the reason the companion MCP decision record treats it as gated on this one. |

## Why "public" and "keyless" do not resolve this

The ESPN endpoints ScoreArc reads are **undocumented and keyless** — no
sign-up, no published contract, no key. That makes them easy to reach, but it
does not make them licensed: the Terms of Use above govern use of the
underlying Disney/ESPN products regardless of which specific unpublished path
serves the data, and nothing in them treats "no authentication required" as
"no restrictions apply." Separately, and just as materially: team names,
club and league crests, and competition marks (e.g. league branding) are
**not ESPN's to grant** under ESPN's own consumer terms at all — clearing
ESPN's terms says nothing about clearing the underlying clubs' and leagues'
trademark and likeness rights. Both questions — the scope of an undocumented
API's terms, and the separate rights of the clubs/leagues whose identity we
mirror — require either qualified counsel's review or an explicit,
negotiated provider agreement. Neither is resolved by this document, and
neither is resolved merely by continuing to observe that the endpoint has no
key.

## Decision: the engineering gate

Until one of the closure conditions below is met, engineering will not:

- Expand external distribution of ESPN-derived data beyond ScoreArc's
  current, already-shipping public site and reader.
- Launch or market any **new** third-party-facing real-data API feature.
- Launch or market any real-data LLM or MCP surface (E8 generation running
  on live ESPN-derived data, or an MCP server exposing it — see the
  companion MCP decision record for the sequencing this implies).
- Train, fine-tune, or validate a model (E9 xG or otherwise) on ESPN-derived
  data.

This gate governs **new** work. It does not instruct disabling, rolling
back, or pausing any currently deployed production service (the live
frontend, ingester, or reader) — a change of that kind is the project
owner's and counsel's decision to make deliberately, with its own tradeoffs,
not a side effect of this engineering note.

### What closes the gate

The gate closes when **one** of the following exists in writing:

1. **Counsel guidance**, addressed to ScoreArc's actual architecture (automated
   collection, persistence, redistribution via the reader, and AI/model use),
   that says the intended use is permitted, with any conditions stated; or
2. **A licensed provider agreement** — replacing or supplementing the current
   ESPN source — whose terms explicitly cover:
   - automated collection (method and rate),
   - which fields and assets (data vs. crests/marks/media) are licensed,
   - retention (how long collected data may be kept),
   - redistribution (to the public reader, to third parties, or both),
   - derivative metrics (e.g., ScoreArc-computed xG, standings snapshots),
   - attribution requirements,
   - AI/model use (training, generation, or both),
   - geographic and commercial scope, and
   - takedown/deletion obligations.

A partial answer to some of these (for example, a license that covers data
fields but is silent on AI use) closes the gate only for the covered uses,
not for all of them.

## Closure evidence and the next accountable decision

**Licensed-source substitution is a viable path, not a rebuild.** ScoreArc's
identity crosswalk (`backend/shared/store/identity.go`, provider `(source,
source_id)` → canonical id) and its provider-mapper seam
(`src/server/data/providers/`) already abstract "which upstream produced this
fact" from "what canonical shape the rest of the system consumes." Swapping
or adding a licensed provider is an integration exercise against an existing
seam, not new architecture.

**What is not yet in place:** fact-level precedence across multiple sources.
If a licensed provider and ESPN ever disagree on the same fact (a score, a
lineup, a scorer), there is no documented rule for which source wins, per
field, per competition. That is a real gap and an open item for whoever
executes the licensed-source path — it is not a blocker to accepting a
license, but it is a prerequisite for actually running two sources side by
side.

**The next accountable decision**, and whose it is: the project owner
decides whether to pursue (1) counsel guidance on the current architecture,
or (2) a licensed-provider evaluation, or both in parallel. Engineering's
role until then is to hold the gate above, not to make that call.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Accept the risk and proceed** | No engineering-level argument establishes this is safe — the license text names automated extraction, database-building, and AI/ML use specifically, and "we have not been asked to stop" is not evidence of permission. Rejected as insufficient engineering proof. |
| **"Derived data" theory** (transforming ESPN facts into ScoreArc-computed values, e.g. standings snapshots or an xG model, makes the license inapplicable) | Rejected for the same reason: derivation does not itself cure a licensing restriction on the underlying collection and use that produced the derived value, and no counsel opinion or license says otherwise. This document does not rely on that theory anywhere above, and no future engineering decision should either without a documented legal basis. |
| **Permission or licensed feed** | The only alternative that produces closure evidence rather than an assumption. **Recommended**: pursue counsel guidance and/or a licensed-provider evaluation per the closure conditions above. |

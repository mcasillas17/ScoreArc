# Product

<!-- impeccable:product-schema 1 -->

> Drafted 2026-11-13 from VISION.md, AGENTS.md and the owner's answers in the
> redesign session. Lines marked (inferred) were not stated by the owner.

## Platform

web

## Users

Football fans in the US and Mexico following several competitions at once
(World Cup, Liga MX, MLS, the big European leagues), in English or Spanish.
They come to check scores, standings, brackets and what is on next, mostly on a
phone (inferred).

## Product Purpose

ScoreArc is a live multi-competition fútbol site: brackets, live scores,
standings, match detail, teams, players and news, at scorearc.futbol. Success
is a reader finding the state of their competition or team in one look.

## Positioning

The knockout bracket is an arc, not a ladder: teams arc around a central
trophy, and leagues render as a radial dial with the qualification cut as an
arc. No other scores site looks like this. Longer term the site reads from
ScoreArc's own data platform and adds its own models (xG, odds, simulations).

## Operating Context

Read during and around matches. Data comes from ESPN's public API today and
from ScoreArc's own Go backend as the cutover proceeds. News stories are
ESPN's and open on ESPN.

## Capabilities and Constraints

- Say "match", never "fixture".
- Every string exists in English and Spanish.
- One stylesheet (`src/app/globals.css`) with namespaced classes and shared
  tokens; components are reused, never duplicated.
- No editorial judgement of our own over provider news: we do not pick a hero
  story.

## Brand Commitments

- The arc / dial / radial language is the identity and stays.
- The colours stay as they are: dark green-tinted neutrals, green for the
  ScoreArc brand, gold only for the prize (qualification, champion, playoff
  place), and one accent per competition.
- Crests, flags and national colours carry the colour; the geometry is the arc.

## Product Principles

1. One thing leads each page; everything else is a line or a link.
2. Remove, merge and reorder before adding.
3. Honour the arc where it carries information, not as decoration.
4. Show nothing stale as if it were current.

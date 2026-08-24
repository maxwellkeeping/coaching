# Coaching — Project Context

A coach-facing app: keep client records, upload each client's training plan as a
PDF, upload their `.fit` files, and get the ride analyzed against what was
prescribed plus a read on how the block is progressing.

## Stack
- **Next.js 16** (App Router, Turbopack) + TypeScript
- **Supabase** (auth, Postgres, RLS) — hosted, no local Docker
- **Anthropic** via `@ai-sdk/anthropic` — PDF plan extraction and ride coaching
- **@garmin/fitsdk** — FIT decoding, no upload ever leaves the server

## Before pushing

```
npx tsc --noEmit       # TypeScript check
npx vitest run         # Unit tests
npm run build          # Full Next.js build
```

## The shape of the app

- **`clients`** — one row per client, owned by the coach. Their FTP and HRmax
  drive every analysis run for their rides; nothing reads the coach's own numbers.
- **`training_plans` / `plan_sessions`** — a plan PDF is read into structured
  sessions (week, day, title, prescription, duration, target load, intensity).
  The PDF itself is not stored; the raw extraction is kept for audit. A client
  has exactly one active plan — saving a new one archives the old.
- **`rides`** — one row per uploaded `.fit`: the computed analysis, the
  comparison against the session it was meant to be, and the coaching feedback.
- **`plan_changes`** — proposed edits to upcoming sessions. The coach applies or
  dismisses; applying writes straight onto the `plan_sessions` row.
- **`client_messages`** — the coaching chat thread, one per client. The chat's
  tools write to the plan and the client, so a correction in conversation is an
  actual fix, not a note.

## Key decisions

- **Plan dates hang off a start date the coach supplies.** Plan PDFs are written
  in weeks and weekdays, not dates. `lib/plan.ts` resolves them, and week 1 runs
  from the start date's own weekday rather than assuming plans begin on a Monday.
- **Extraction is reviewed before it is saved.** `POST /api/clients/[id]/plan`
  extracts and returns a draft; `PUT` saves what the coach confirmed. A plan
  nobody checked would quietly corrupt every comparison made against it.
- **Proposed changes are filtered to real upcoming sessions** before they are
  saved, and their fields are coerced to the plan's columns — a hallucinated
  session ID or field never reaches the database.
- **The plan start date is editable, and re-dates the plan.** The date printed
  on a plan PDF is rarely the date the client began. `PATCH
  /api/clients/[id]/plan` and the chat's `set_plan_start_date` both recompute
  every `plan_sessions.session_date` from the new start. Rides already uploaded
  keep the comparison they were given — re-upload to re-match.
- **Shape is read without reference to FTP.** `lib/segments.ts` splits a ride
  into steady segments by change-point detection and finds the repeating
  patterns in them — "3 × (2min @ 262W, 2min @ 224W)". No FTP is involved,
  because the FTP on a client record is often stale and a workout's shape does
  not stop existing when that number is wrong. The work/rest boundary is found
  in the widest gap between the ride's own power levels, not at a fixed
  fraction: a warmup at ~62% of working power sits either side of any fixed
  line, and merging it into the first interval drags the whole reading down a
  band.
- **Rides are matched and judged on their shape, not the calendar.**
  `lib/workout-structure.ts` names what the ride was — over-unders, VO2max,
  threshold, sweet spot, steady — from those segments, inferring the intervals
  when the rider never pressed lap. A session recognised by structure
  within a few days of its prescribed date counts as that session, moved. This
  is what stops the app reporting an over-under done a day late as the wrong
  workout.
- **An over-under's under legs are by design, not a failure.** Its average sits
  in the threshold band, so archetype detection tests for alternation before
  testing averages, and the intensity-shortfall rule is suppressed for it.
- **Analysis degrades rather than refusing.** No FTP means no zones, TSS or
  %FTP, but decoupling, fade and duration still compute. No plan means the ride
  is analyzed as unplanned.

## Testing

Vitest, tests alongside source (`lib/foo.test.ts`). Run `npx vitest run`.

The deep modules to keep tested:
- `lib/plan.ts` — date resolution and ride-to-session matching
- `lib/plan-match.ts` — executed vs prescribed, and the compliance verdict
- `lib/progression.ts` — the block-level trend maths
- `lib/fit-parser.ts` / `lib/fit-analysis.ts` — FIT decoding and the 1Hz grid

FIT tests build synthetic `.fit` files with `lib/fit-fixture.ts` rather than
checking binary ride files into the repo.

## Supabase

No local Docker. To apply a migration, paste the SQL into the **Supabase
dashboard → SQL Editor**. Migrations live in `supabase/migrations/`.

## Environment variables

- `ANTHROPIC_API_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

# Coaching

Upload a client's training plan, upload their ride files, get the ride analyzed
against what you prescribed and a read on how their block is going.

## What it does

1. **Clients** — name, FTP, HRmax, weight, goal, phase, notes.
2. **Plan** — upload the plan PDF you wrote for them. It is read into structured
   sessions, which you review before saving. You set the start date; every
   session date follows from it.
3. **Rides** — upload a `.fit` file. It is decoded and analyzed against *their*
   FTP: zone distribution, normalized power, cardiac decoupling, efficiency by
   thirds, late-ride fade, per-interval execution and best efforts.
4. **Comparison** — the ride is matched to the session it was meant to be (same
   day, or a day either side) and judged against it: duration, load, and for
   quality sessions whether the work intervals actually landed on target.
5. **Progression** — week by week across everything uploaded: volume, load,
   aerobic efficiency (W/bpm), decoupling and plan compliance, with the trend
   called only once there is enough history to call it.
6. **Plan changes** — suggested edits to upcoming sessions, which you apply or
   dismiss. Applying writes onto the plan.

Each upload also produces a short message written to the client, ready to send.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in the four values
npm run dev
```

Apply `supabase/migrations/20260824000000_init.sql` in the Supabase SQL editor
before first use.

# Metric definitions

Every number in the dashboard and reports comes from one SQL function in `supabase/migrations/20261019000700_reporting.sql`. Each definition below is covered by an exact-value test in `supabase/tests/db/05_reporting.sql`.

## Periods and time zones

* A period is a pair of **calendar dates** `[from, to]`, inclusive.
* Dates are interpreted in **each company's own time zone** (`companies.timezone`): the period runs from `from 00:00` local to `to + 1 day 00:00` local. A deal won at 22:00 UTC on 31 August counts in **September** for a company in Asia/Qatar (UTC+3) — this exact case is tested.
* "Today", "this week" and "this month" are resolved in the company's time zone (`src/lib/dates/periods.ts`). Weeks start on **Sunday** (Gulf work week); configurable.
* Maximum period: 366 days.
* *Snapshot* metrics describe the state **now** and ignore the period.

## Attribution rules

* **Created** metrics credit the **creator** (`created_by`). **Ownership** metrics credit the **current owner**. They are never mixed: a lead created by A and reassigned to B counts as created by A and owned by B.
* Team filters use **current** team membership.
* Absence of recorded activity is reported as *zero recorded*, not as zero work. Ratios with no denominator are shown as "—", never 0%.

## Company KPIs — `report_company_kpis`

| Metric | Definition |
|---|---|
| Open leads *(snapshot)* | Leads not archived with status `new`, `contacted` or `qualified`. |
| Leads created | Leads with `created_at` in the period (credited to creator). **Automatic WhatsApp leads have no creator**: they count in company-wide totals for admins/super admins, but are credited to no employee in per-employee reports or in manager (team-scoped) views. |
| Leads converted | Of the leads created in the period, those that now have a deal (cohort). |
| Lead conversion rate | Leads converted ÷ leads created. |
| Open deals *(snapshot)* | Deals with status `open`, not archived. |
| Open pipeline value *(snapshot)* | Σ amount of open deals. **Estimate — not revenue.** |
| Weighted pipeline *(snapshot)* | Σ amount × probability ÷ 100 of open deals. |
| Deals won / lost | Deals whose `won_at` / `lost_at` falls in the period. `won_at` is set by the database when the deal enters a *won* stage and cannot be backdated by users. |
| **Won revenue (realized)** | Σ amount of deals **won in the period**, in the company currency. A deal that merely exists, or is open at 90 % probability, contributes nothing. |
| Win rate | Won ÷ (won + lost) in the period. |
| Overdue tasks *(snapshot)* | Status `open`/`in_progress` and `due_at` < now. Completed and canceled tasks are never overdue. |
| Tasks completed | `completed_at` in the period. |
| Activities logged | Activities with `occurred_at` in the period. |

Revenue is reported per company in that company's currency. The dashboard (pending) will sum cross-company totals only when currencies match, and otherwise show companies side by side.

If a won deal is reopened (managers only, audited), it stops counting as revenue. Changing a won deal's amount is managers-only and audited (`deal.won_amount_changed`).

## Employee performance — `report_employee_performance`

| Metric | Definition |
|---|---|
| Leads created | Leads with `created_by` = employee, created in the period. |
| Leads assigned | Assignment events (`lead_assignments`) **to** the employee in the period. |
| Leads contacted | Distinct leads on which the employee logged a call, meeting, e-mail or WhatsApp activity in the period. |
| Calls / meetings logged | Activities of that type by the employee in the period. |
| Follow-ups completed | Tasks **completed by** the employee (`completed_by`) in the period. |
| Overdue tasks *(snapshot)* | Tasks assigned to the employee, open, past due. |
| Deals created | Deals with `created_by` = employee in the period. |
| Deals won / lost, won revenue | Deals **owned** by the employee with `won_at` / `lost_at` in the period. |
| Win rate | Won ÷ (won + lost). |
| WhatsApp replies | Outbound messages with `sent_by` = employee in the period, not failed, not simulated. |
| Sign-ins | `sign_in` events in the period. **This is login activity, not working time.** The system does not measure online status or working hours. |

## Goal attainment — `report_target_progress`

Targets (`sales_targets`) apply to one user, a team (current members) or the whole company, for a date range. The actual value uses exactly the definitions above for the metric named. Attainment = actual ÷ target.

The actual is shown only if it lies inside the viewer's report scope (since `0840`): an agent sees a company-wide or another team's target, but its actual and attainment are empty for them. Admins and the managers of that team see the values.

## WhatsApp response time — `report_whatsapp_response`

* A **customer turn** starts with the first inbound message after the previous outbound message (or the first inbound ever). Several quick customer messages form one turn.
* Its **response** is the first later outbound message **sent by an authenticated employee** (`sent_by` not null, not failed). Response time = response − first message of the turn.
* Messages sent from the WhatsApp Business **phone app** (coexistence echoes) or by automation have no `sent_by`. They are **not credited to anyone**; turns answered only that way count as *unanswered by an attributed employee*.
* The first three columns are **calendar time**: a message at 23:00 answered at 08:00 counts as 9 hours.
* The **business-hours** columns (average, median, share within 15 business minutes) count only the part of each wait that falls inside the company's business hours (`company_business_hours`, one or more intervals per weekday, in the company's timezone, DST-safe), excluding holidays (`company_holidays`). The same 23:00 → 08:00 wait with hours starting 08:00 counts as 0. Computed by `app.business_seconds(company, from, to)`.
* If a company has **no business hours configured**, the business-hours columns are **NULL** ("not configured"), never 0. Hours apply to past periods too as soon as they are saved (the schedule is not versioned).
* Simulated (development) messages are excluded unless `p_include_simulated` is true.

## Daily series — `report_daily_series`

The same definitions, bucketed by local day. Daily sums equal the period totals (tested).

## Sandbox companies

Companies flagged `is_sandbox` (Kapso Sandbox test companies) are outside **every** report scope: they never appear in company KPIs, employee performance, targets, daily series, WhatsApp response times or the WhatsApp workload, for any caller including the super admin, and an explicit request for one returns nothing. They are excluded in the database (`app.report_scope()` and `report_whatsapp_workload`), not in the UI. `docs/KAPSO_SANDBOX.md` §6 lists the proof (a differential test over every report function, with mutation and non-vacuity controls).

## Scope

Reports apply the same visibility as RLS: admins see the company; sales managers see themselves, members of teams they manage and unassigned records; agents see only themselves.

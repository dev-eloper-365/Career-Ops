# Mode: daily-apply -- Cron-Safe Daily Auto-Apply Workflow

## Trigger

- Cron job (via `/schedule` skill) runs `node daily-apply.mjs` at 11am IST daily
- Manual: User says `/career-ops daily-apply` or `node daily-apply.mjs`
- Headless `claude -p` subprocess calls (invoked by `daily-apply.mjs` for discovery stages)

## What This Does

Fully autonomous. Zero human confirmation. One run discovers 4 new companies (3 startups + 1 MNC data analyst), finds 5 hierarchy contacts per company, sends 20 emails total. Dedup against `data/email-history.md` guarantees no repeat companies.

---

## Orchestration Flow (executed by `daily-apply.mjs`)

### Stage 1: Company Discovery

`daily-apply.mjs` spawns `claude -p` with this prompt:

```
Read /Users/patel/Code/career-ops/portals.yml daily_apply.tier1_startup_queries.
Run the enabled queries in priority order via WebSearch until you have found {N} companies matching ALL criteria:

1. Currently hiring for software dev role (full stack, backend, Node.js, MERN, data analyst)
2. Based in India or remote-accepting-India
3. Have a careers page or LinkedIn job post URL
4. NOT in this excluded company list: {dedup_list}

Return strict JSON (no prose):
{
  "companies": [
    {
      "name": "Acme",
      "role": "Full Stack Developer",
      "jd_url": "https://...",
      "platform": "cutshort",
      "stack_hints": ["Node.js", "MongoDB", "React"]
    }
  ]
}
```

Repeat for Tier 2 (MNC data analyst) if Tier 1 did not fill quota.

### Stage 2: Contact Discovery (per company)

For each discovered company, `daily-apply.mjs` spawns another `claude -p`:

```
Find 5 contacts at {company} in this hierarchy (one per tier):

1. HR / Talent Acquisition / Recruiter
2. Team Lead / Tech Lead / Engineering Lead
3. Senior Developer / SDE-2 / Senior Engineer
4. Engineering Manager / Director
5. Founder / Co-Founder / CTO / CEO

Use this priority per contact (stop at first hit):
a. Verified public email (LinkedIn bio, GitHub, public page, conference speaker bio)
b. Hunter.io / Apollo.io / RocketReach indexed result via WebSearch
c. Guessed company email pattern (first.last@domain based on known format)

Return strict JSON:
{
  "company": "{company}",
  "role": "{role}",
  "jd_summary": "<2-3 sentence summary>",
  "contacts": [
    {
      "tier": "HR|TeamLead|Developer|Manager|Founder",
      "name": "Full Name",
      "email": "addr@domain.tld",
      "confidence": "verified|guessed",
      "linkedin_url": "https://...",
      "linkedin_fallback": false
    }
  ]
}

Skip contact entirely if no email and no LinkedIn URL found.
Set linkedin_fallback: true if only LinkedIn found (no email).
```

### Stage 3: Queue + Validate + Send

`daily-apply.mjs` handles this in pure Node (no LLM):

1. Write merged `data/contacto-export.json` with all contacts from all companies
2. Apply tier-specific template from `templates/email-tier-templates.md` to each contact body
3. `node emailer.mjs queue --from-contacto --template cold` → creates drafted rows
4. `node emailer.mjs validate` → MX check guessed domains
5. Auto-delete any rows with failed MX records
6. `node emailer.mjs approve --ids <new_ids> --allow_guessed`
7. `node emailer.mjs send --ids <new_ids> --live --confirmed --allow_guessed`
8. Append summary to `data/daily-apply-log-{YYYY-MM-DD}.md`

---

## Dedup Rules (critical — never skip)

Before queuing any email, check in order:

1. **Company-level:** company name (lowercased) NOT in `data/email-history.md` column 5
2. **Email-level:** email address NOT in `data/email-history.md` column 4
3. **Status check:** company NOT in `data/applications.md` with status in {Applied, Responded, Interview, Offer, Rejected, SKIP, Discarded}

If ANY check fails → skip that company/contact. Move to next.

---

## Output: daily-apply-log-{date}.md

```markdown
# Daily Apply Log — {date}

## Summary
- Companies discovered: {N}
- Companies skipped (dedup): {M}
- Contacts queued: {K}
- Contacts validated: {K - bounced}
- Emails sent: {sent_count}
- Daily cap remaining: {20 - sent_count}

## Companies
| Company | Role | Platform | HR | Lead | Dev | Mgr | Founder |
|---------|------|----------|-----|------|-----|-----|---------|
| Acme | Full Stack | cutshort | ✅ | ✅ | ✅ | ❌ | ✅ |
...

## Errors
- Company X: no contacts found for any tier → skipped
- Email Y@z.com: MX validation failed → auto-deleted
```

---

## Error Handling (cron-safe)

| Situation | Action |
|-----------|--------|
| SMTP creds missing | Log error, exit 1. Cron job reports failure. |
| `claude -p` subprocess fails | Retry once. If still fails, log and skip that stage. |
| No companies discovered | Log empty run, exit 0. |
| Daily cap already hit | Log and exit 0 (normal). |
| All contacts bounce on validate | Log, skip company, continue. |
| Partial send (cap hit mid-run) | Log sent + pending counts. Pending rows stay `approved` for next day. |

Never throws unhandled exceptions. Cron reliability > graceful degradation.

---

## What Never Happens in This Mode

- No interactive prompts (no `y/n`, no confirmation, no pauses)
- No edits to system files during run
- No commits to git
- No sending to companies in excluded list
- No email to addresses without MX records
- No more than 20 sends per day (emailer.mjs enforces)
- No contacts found via unverified scraping (stick to WebSearch + public pages)

---

## What User Needs to Provide

Pre-setup (once):
- `EMAIL_SMTP_USER` and `EMAIL_SMTP_PASS` env vars available at cron time
- `DevSDE2026.pdf` resume in project root
- `portals.yml` with `daily_apply:` block configured
- Claude Code CLI installed and authenticated (for `claude -p` subprocess)

Daily: nothing.

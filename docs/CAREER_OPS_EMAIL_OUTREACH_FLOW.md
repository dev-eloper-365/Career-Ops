# Career-Ops Opportunity + Email Outreach Flow

This guide combines three parts into one operational flow:

1. Use career-ops to find and prioritize real opportunities.
2. Use career-ops to research each company and find relevant contacts.
3. Use `emailer.mjs` to send targeted outreach with your fixed resume attachment.

It is designed for quality outreach, not spam.

## What This Flow Does

- Finds opportunities from your configured portals and pipeline.
- Evaluates fit before outreach.
- Researches company context before outreach.
- Finds technical contacts and classifies confidence (verified vs guessed).
- Validates guessed email domains via DNS MX check.
- Lets you create technical-only recipient drafts from contacto output.
- Shows full personalized draft per recipient before any live send.
- Requires explicit approval + confirmation before sending.
- Sends with `DevSDE2026.pdf` only.

## Preconditions

- `cv.md` exists.
- `config/profile.yml` exists and has your real name/email.
- `portals.yml` exists and is aligned to your target roles.
- `DevSDE2026.pdf` exists at repository root.
- Gmail App Password is available for live sending.

## End-to-End Flow

### Step 1: Find Opportunities

Run scanner (low-cost source discovery):

```bash
node scan.mjs
```

Optional: process pipeline URLs if you added postings manually:

```bash
# through your normal /career-ops pipeline mode flow
```

### Step 2: Evaluate and Filter

Evaluate each role first and prioritize high-fit roles only.

Recommended rule:
- Apply/outreach only for strong matches.
- Skip low-fit roles to avoid noise.

If you use reports and tracker updates, keep status canonical in `data/applications.md`.

### Step 3: Research Company Context (Career-Ops)

Before drafting outreach, gather context so messages are specific:

- Use `/career-ops deep` for company intel:
  - products/platforms
  - current initiatives
  - technical stack clues
  - hiring signals

This is the "about company" step and should happen before contacting anyone.

### Step 4: Find Technical Contacts (Career-Ops)

Use `/career-ops contacto` to find likely people/paths for outreach, then keep only technical recipients.

Target technical recipients only (engineering, CTO, platform, architecture, delivery engineering), and exclude sales/marketing/general business contacts.

Examples:
- CTO
- VP/Director Engineering
- Engineering Manager
- Technical Hiring Manager

When a contact email is not directly published, mark as guessed and require explicit guessed approval later.

**After contacto runs:** ask Claude to save contacts to `data/contacto-export.json` for direct queue import.

### Step 5: Queue Draft Emails

Option A — from contacto export (recommended after Step 4):

```bash
node emailer.mjs queue --from-contacto [--template cold|followup|referral]
```

Option B — manual recipients:

```bash
node emailer.mjs queue \
  --to "Dipesh Shah <dipesh.shah@drcsystems.com>,Pankaj Bhatia <pankaj.bhatia@drcsystems.com>" \
  --company "DRC Systems" \
  --role "Software Development Engineer 2026" \
  --jd "Backend API ownership, cloud reliability, CI/CD, platform engineering" \
  --template cold \
  --guessed
```

Notes:
- Use `--guessed` when emails are inferred.
- Templates: `cold` (default), `followup`, `referral`.

### Step 5b: Check Status

```bash
node emailer.mjs status
```

Shows drafted/approved/sent/failed counts, today's cap, and ready IDs.

### Step 6: Validate Guessed Email Domains

Before editing or approving, check DNS MX records for guessed addresses:

```bash
node emailer.mjs validate
# or specific rows:
node emailer.mjs validate --ids 7,8
```

Rows with invalid domains get flagged in `last_error`. Delete suspect rows before proceeding:

```bash
node emailer.mjs delete --ids 9
```

### Step 7: Edit/Rewrite Drafts If Needed

Adjust body or subject to reflect specific company context:

```bash
node emailer.mjs edit --id 3 --body "Hi Jane, I noticed your team at Acme is..."
node emailer.mjs edit --id 3 --subject "Backend platform opportunity at Acme"
```

Editing body/subject of an approved row resets it to drafted (re-approval required).

Preview full draft after edits:

```bash
node emailer.mjs preview --status drafted --full
```

### Step 8: Approve Explicitly

For guessed emails, include explicit guessed approval:

```bash
node emailer.mjs approve --ids 1,2 --allow_guessed
```

### Step 9: Dry Run First

```bash
node emailer.mjs send --ids 1,2 --allow_guessed
```

This records dry-run actions without network send.

### Step 10: Live Send

Set SMTP env vars (Gmail):

```bash
export EMAIL_SMTP_USER="your-address@gmail.com"
export EMAIL_SMTP_PASS="your-16-char-app-password"
```

**Step 10a — Review drafts (no send yet):**

```bash
node emailer.mjs send --ids 1,2 --live --allow_guessed
```

This shows full personalized drafts for every recipient and stops. Verify subject, body, and recipient for each.

**Step 10b — Confirm and send:**

```bash
node emailer.mjs send --ids 1,2 --live --confirmed --allow_guessed
```

### Step 11: Verify Outcome

```bash
node emailer.mjs preview --status sent
```

Check audit trail in:
- `data/email-history.md`

### Step 12: Retry Failures (if any)

If any rows show `failed` status:

```bash
node emailer.mjs status           # see failed IDs
node emailer.mjs retry --ids 3    # reset to approved
node emailer.mjs send --ids 3 --live --confirmed
```

## Exact Rules Enforced by This Flow

- Fixed resume attachment only: `DevSDE2026.pdf`
- Approval required before send (`status=approved`)
- Live send always shows full drafts before sending — requires `--confirmed` to proceed
- Guessed recipients require explicit allow flags
- Daily and spacing guards:
  - Max 20 per day
  - Minimum 90 seconds between sends
- Duplicate send: warns if same email+company already sent, does not block
- Sent rows cannot be edited or deleted

## How To Use This Practically

Use this operating loop for each company:

1. Find role via scanner/pipeline.
2. Evaluate fit first.
3. Research the company with `/career-ops deep`.
4. Find contacts with `/career-ops contacto`. Save to contacto-export.json.
5. Keep only technical recipients.
6. Queue drafts: `emailer.mjs queue --from-contacto`.
7. Validate guessed domains: `emailer.mjs validate`.
8. Edit drafts to personalize: `emailer.mjs edit --id N --body "..."`.
9. Approve explicitly: `emailer.mjs approve --ids N`.
10. Dry-run: `emailer.mjs send --ids N`.
11. Review live drafts: `emailer.mjs send --ids N --live`.
12. Confirm and send: `emailer.mjs send --ids N --live --confirmed`.
13. Track sent status and follow up.

## Common Commands Cheat Sheet

```bash
# Initialize queue/history files
node emailer.mjs init

# Status dashboard
node emailer.mjs status

# Queue from contacto export
node emailer.mjs queue --from-contacto [--template cold|followup|referral]

# Queue from tracker notes emails
node emailer.mjs queue --from-tracker

# Queue manual recipients
node emailer.mjs queue --to "Name <email>" --company "Acme" --role "SWE" --jd "APIs" [--guessed]

# Validate guessed email domains (DNS MX)
node emailer.mjs validate [--ids 1,2]

# Preview queue
node emailer.mjs preview

# Preview full draft content (subject/body/attachment)
node emailer.mjs preview --status drafted --full

# Edit a draft
node emailer.mjs edit --id 3 [--body "..."] [--subject "..."] [--to "Name <email>"] [--confidence verified|guessed]

# Approve rows
node emailer.mjs approve --ids 1,2 [--allow_guessed]

# Retry failed rows
node emailer.mjs retry --ids 3

# Delete draft/failed rows
node emailer.mjs delete --ids 5

# Send dry run
node emailer.mjs send --ids 1,2 [--allow_guessed]

# Review live drafts (no send — omit --confirmed)
node emailer.mjs send --ids 1,2 --live [--allow_guessed]

# Confirm and send live
node emailer.mjs send --ids 1,2 --live --confirmed [--allow_guessed]
```

## Safety and Quality Guidance

- Do not bulk-send to non-technical inboxes.
- Keep outreach concise and role-specific.
- Prefer 1-3 high-quality contacts over mass blasts.
- Never send without reviewing draft relevance.
- Never skip the company research step.
- Always validate guessed email domains before sending.

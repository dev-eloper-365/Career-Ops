# Mode: outreach -- End-to-End Email Outreach Autopilot

## Trigger

User says: `/career-ops outreach <company name>` or "outreach [company]" or "send outreach to [company]"

## What This Does

Fully automated loop from company name → researched, personalized, validated draft emails ready to send. User only approves at the end.

---

## Step 1: Find the Application

Search `data/applications.md` for a row matching the company name (case-insensitive).

- Extract: company, role, report link, status, score
- If multiple rows found: pick highest score or most recent date, tell the user
- If not found: ask "I don't see [company] in your tracker. Do you want me to evaluate a JD first, or proceed with outreach anyway?"
- If status is `Discarded` or `SKIP` or `Rejected`: warn the user before continuing

Read the linked report file (if it exists) for JD context, stack details, and role summary.

---

## Step 2: Deep Company Research

Run the deep research flow (from `modes/deep.md` logic) focused on:
- Current engineering initiatives
- Technical stack
- Team structure clues
- Recent news/funding
- Any signals relevant to outreach timing

Keep findings compact — you need 2-3 specific hooks for the email body.

---

## Step 3: Find Contacts

Run contacto logic (from `modes/contacto.md`) to find:
- CTO / VP Engineering
- Engineering Director / Engineering Manager
- Hiring Manager for the role (if identifiable)
- HR contacts: Head of HR, Talent Acquisition, Recruiter (role-specific if possible)
- Find ALL contacts discoverable — no cap

Rules:
- No sales contacts
- Technical + HR/Recruiting — include all engineering and people team contacts
- For each contact: name, title, email, LinkedIn URL
- If no contacts found with confidence: tell user and ask how to proceed

**Email priority order (stop at first hit per contact):**

1. **Verified public email** — search `"{name}" "{company}" email site:linkedin.com OR site:github.com OR site:twitter.com OR site:medium.com` and check public profiles, bios, blog posts, conference speaker pages, open source commits
2. **Hunter.io / Apollo.io search** — WebSearch `"{name}" "{company}" site:hunter.io OR site:apollo.io OR site:rocketreach.co` for indexed verified addresses
3. **Guessed company email** — apply the domain's known format (first.last@domain, first@domain, etc.) — set `confidence: "guessed"`

If step 1 or 2 yields an email: set `confidence: "verified"`.
If only step 3: set `confidence: "guessed"` and flag it.
If no email found at all: set email to `null`, set `linkedin_fallback: true` — skip email queue and go straight to LinkedIn DM draft.

---

## Step 4: Build contacto-export.json

Write `data/contacto-export.json` with this exact format:

```json
{
  "company": "<company>",
  "role": "<role from tracker>",
  "jd_summary": "<2-3 sentence technical summary from report>",
  "template": "cold",
  "contacts": [
    {
      "name": "<full name>",
      "email": "<email or null>",
      "confidence": "verified|guessed",
      "linkedin_url": "<linkedin profile url or null>",
      "linkedin_fallback": false,
      "type": "hiring_manager"
    }
  ]
}
```

Tell the user how many contacts were written.

---

## Step 5: Queue Emails

For contacts where `linkedin_fallback: false` (have an email):

```bash
node emailer.mjs queue --from-contacto --template cold
```

For contacts where `linkedin_fallback: true` (no email found): skip email queue entirely. Instead, generate a LinkedIn DM draft (same body rules as Step 7) and show it to the user inline. Tell the user: "No email found for [name] — LinkedIn message drafted instead."

Show the user which email IDs were created and which contacts got LinkedIn drafts.

---

## Step 6: Validate Guessed Domains

Run:

```bash
node emailer.mjs validate
```

- If any domains fail: delete those rows automatically, tell user which were removed
- If all fail: stop and tell user — cannot proceed without valid domains

```bash
# Delete bad rows if needed
node emailer.mjs delete --ids <bad_ids>
```

---

## Step 7: Personalize Each Draft

For each valid queued row, craft a personalized body using:
- Recipient name and title
- Specific company research hook from Step 2
- Role-relevant proof point from cv.md or article-digest.md
- JD context from the report

Then edit each row:

```bash
node emailer.mjs edit --id <n> --body "<personalized body>"
```

Body rules:
- 3 short paragraphs max
- Paragraph 1: specific hook about their company/team (not generic)
- Paragraph 2: single strongest proof point that maps to their problem
- Paragraph 3: soft CTA — "happy to share more" not "please hire me"
- Sign off: `Best,\nDev Patel`
- NO dashes or hyphens anywhere in the body text
- NO em dashes, NO hyphenated words (write "full stack" not "full-stack")
- NO corporate speak, NO "I am passionate about"
- NEVER mention student status, university, CGPA, graduation year, or degree — frame as a working engineer with production experience

---

## Step 8: Show All Drafts for Approval

Run:

```bash
node emailer.mjs preview --status drafted --full
```

Print output to user. Then ask:

> "Here are the personalized drafts above. Approve to proceed?
> - Say **yes** to approve and move to send review
> - Say **edit [id]** to change a specific draft
> - Say **no** to cancel"

If user says **edit [id]**: run the edit command with their revised text, re-show that draft, ask again.

Do NOT proceed to approval/send until user explicitly says yes.

---

## Step 9: Approve

Once user approves:

```bash
node emailer.mjs approve --ids <all_valid_ids> --allow_guessed
```

---

## Step 10: Live Send Review (Pre-Flight)

Show full pre-send review without sending:

```bash
EMAIL_SMTP_USER="your-address@gmail.com" EMAIL_SMTP_PASS="$EMAIL_SMTP_PASS" \
  node emailer.mjs send --ids <ids> --live --allow_guessed
```

This triggers the built-in pre-send preview gate (no send yet — `--confirmed` not included).

Tell user:
> "All drafts shown above. Run with --confirmed to send, or say 'send' and I'll execute it."

---

## Step 11: Send on Confirmation

Only when user explicitly says "send" / "confirmed" / "go":

```bash
EMAIL_SMTP_USER="your-address@gmail.com" EMAIL_SMTP_PASS="$EMAIL_SMTP_PASS" \
  node emailer.mjs send --ids <ids> --live --confirmed --allow_guessed
```

Show send results.

---

## Step 12: Summary

After send:

```bash
node emailer.mjs status
```

Tell user:
- How many sent
- Which companies/contacts
- Reminder to follow up in 5-7 business days via `/career-ops followup`

---

## Error Handling

| Situation | Action |
|-----------|--------|
| Company not in tracker | Offer to evaluate JD first |
| No contacts found | Ask user to provide contacts manually |
| All domains invalid | Stop, report, ask user how to proceed |
| SMTP creds missing | Tell user: `export EMAIL_SMTP_USER=... EMAIL_SMTP_PASS=...` |
| Daily cap hit | Report remaining cap, ask if user wants to queue for tomorrow |
| Send fails | Auto-retry once, then report error |

## What User Needs to Provide

Only: **company name**

Everything else is automated. User only approves drafts (Step 8) and confirms send (Step 11).

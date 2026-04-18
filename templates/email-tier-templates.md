# Email Tier Templates for Daily Auto-Apply

5 tier-specific cold email templates used by `daily-apply.mjs`.

## Global rules (apply to ALL templates)

- Subject line: `Application | {role} | Dev Patel`
- NO hyphens, dashes, or em dashes anywhere in body
- NO hyphenated words (write "full stack" not "full-stack")
- NEVER mention: student status, university, CGPA, graduation year, "final year"
- NO corporate speak: no "I am passionate about", no "synergies", no "leverage"
- Max 3 short paragraphs
- Signature: `Best,\nDev Patel\n+91 99746 50993`
- Always attach `DevSDE2026.pdf` (emailer enforces this)

---

## Tier 1: HR / Talent Acquisition / Recruiter

**Framing:** Direct application. Formal. Focus on shipped production work.

```
Hi {first_name},

I am applying for the {role} opening at {company}. I have production experience in {stack_match} and would love to be considered.

At PlayPower Labs I build iOS and Android learning apps, AWS ECS backend with Blue Green deployments, and Python ETL pipelines for content migration. At Summit Interconnect I built a multi tenant SaaS backend with async job queues, RBAC middleware, and a hybrid AI search engine. Resume attached with full details.

Available for a quick call any time this week.

Best,
Dev Patel
+91 99746 50993
```

---

## Tier 2: Team Lead / Tech Lead / Engineering Lead

**Framing:** Technical peer. Specific to their stack if known. Position as joining their team.

```
Hi {first_name},

I am reaching out because I would like to join the {company} engineering team as {role}. The work your team ships at scale is exactly the kind of problem space I am drawn to.

I currently build {primary_stack} systems at PlayPower Labs, including AWS ECS Fargate deployments with Blue Green rollout, Python ETL pipelines for curriculum content, and native iOS and Android apps shipped to both stores. Before that I architected a multi tenant SaaS with per tenant data partitions and async job queues at Summit Interconnect.

If you have a spot open on your team I would love to chat. Resume attached.

Best,
Dev Patel
+91 99746 50993
```

---

## Tier 3: Developer / Senior Engineer (peer referral ask)

**Framing:** Peer level. Collaborative. Soft referral ask. Not an application pitch.

```
Hi {first_name},

I came across your work at {company} and wanted to reach out as a fellow engineer. I am applying for the {role} role there and thought a quick note might help.

I build full stack systems at PlayPower Labs, focusing on backend infra on AWS, Python ETL for content migration, and mobile apps. Also shipped a multi tenant SaaS backend at Summit Interconnect with async job queues and a hybrid AI search engine.

If you have a moment, would love your thoughts on the team. Resume attached in case you are open to a referral.

Best,
Dev Patel
+91 99746 50993
```

---

## Tier 4: Engineering Manager / Director of Engineering

**Framing:** Mix technical + delivery. Emphasize shipping cadence and reliability.

```
Hi {first_name},

I am applying for the {role} role at {company}. Wanted to reach out directly since you lead the engineering team.

I ship production systems fast. At PlayPower Labs I architected Blue Green deployments on AWS ECS Fargate with S3 artifact storage, published a math learning app to iOS and Google Play, and ran content migration ETL across 12 plus curriculum units. At Summit Interconnect I built an idempotency layer with DB transaction locking, async job queues with retry plus dead letter, and an event driven architecture with cache invalidation. All production grade, all remote.

Open to a quick call to discuss fit. Resume attached.

Best,
Dev Patel
+91 99746 50993
```

---

## Tier 5: Founder / Co Founder / CTO / CEO

**Framing:** Bold. Vision aligned. Specific about what you would build there.

```
Hi {first_name},

Reaching out directly because I want to join {company}. I am applying for {role} and wanted to skip the queue.

The short pitch. I ship production systems end to end. AWS ECS with Blue Green rollouts, Python ETL pipelines, native iOS and Android apps, multi tenant SaaS backends, agentic RAG pipelines with LangGraph and LangChain. I built a groundwater analytics platform that reached the SIH 2025 Grand Finals with 40K plus rows across 6,800 plus locations. I move fast and things I ship stay shipped.

If you are open to a 15 minute chat about where I could contribute, I am in. Resume attached.

Best,
Dev Patel
+91 99746 50993
```

---

## Placeholders (replaced at runtime by daily-apply.mjs)

| Token | Source |
|-------|--------|
| `{first_name}` | From contact discovery (falls back to "team" if name missing) |
| `{company}` | From company discovery |
| `{role}` | From job listing |
| `{stack_match}` | Inferred from JD keywords matched against CV skills |
| `{primary_stack}` | Top stack from JD (e.g., "Node.js", "MERN", "Python") |

If placeholders cannot be filled from available data, use safe defaults:
- `{first_name}` → `"team"` (use `Hi team,`)
- `{stack_match}` → `"Node.js, AWS, and mobile"`
- `{primary_stack}` → `"full stack"`

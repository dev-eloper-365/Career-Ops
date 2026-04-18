#!/usr/bin/env node
/**
 * daily-apply.mjs -- Cron-safe daily auto-apply orchestrator for career-ops.
 *
 * Runs the full pipeline with no human confirmation:
 *   1. Build dedup set from email-history.md + applications.md
 *   2. Discover new companies via `claude -p` WebSearch subprocess (tier 1 startups, then tier 2 MNCs)
 *   3. For each company, find 5 hierarchy contacts (HR, TeamLead, Developer, Manager, Founder)
 *   4. Queue emails via emailer.mjs with tier-specific body templates
 *   5. Validate MX, auto-delete bounces
 *   6. Approve + send (respects 20/day cap + 90s rate limit)
 *   7. Write daily-apply-log-{date}.md
 *
 * Flags:
 *   --dry-run           Discover + plan but do not queue/send
 *   --limit <N>         Cap companies discovered this run (default: from portals.yml)
 *   --skip-discovery    Reuse last contacto-export.json instead of discovering
 *   --tier1-only        Only discover startups
 *   --tier2-only        Only discover MNCs
 *
 * Requires env:
 *   EMAIL_SMTP_USER, EMAIL_SMTP_PASS  (same as emailer.mjs)
 *   PATH must include `claude` CLI
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = join(ROOT, 'portals.yml');
const TEMPLATES_PATH = join(ROOT, 'templates/email-tier-templates.md');
const HISTORY_PATH = join(ROOT, 'data/email-history.md');
const APPS_PATH = join(ROOT, 'data/applications.md');
const CONTACTO_EXPORT_PATH = join(ROOT, 'data/contacto-export.json');
const QUEUE_PATH = join(ROOT, 'data/email-queue.tsv');
const LOG_DIR = join(ROOT, 'data');

// -----------------------------------------------------------------------------
// CLI args
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args.flags[key] = true;
    } else {
      args.flags[key] = next;
      i++;
    }
  }
  return args;
}

// -----------------------------------------------------------------------------
// Config + config-derived data
// -----------------------------------------------------------------------------

function loadConfig() {
  if (!existsSync(PORTALS_PATH)) throw new Error(`Missing portals.yml at ${PORTALS_PATH}`);
  const yml = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const daily = yml?.daily_apply;
  if (!daily) throw new Error('portals.yml missing daily_apply block.');
  const allT1 = (daily.tier1_startup_queries || []).filter((q) => q.enabled !== false);
  const allT2 = (daily.tier2_mnc_queries || []).filter((q) => q.enabled !== false);
  return {
    tier1Queries: allT1,
    tier2Queries: allT2,
    quota: daily.daily_quota || { tier1_startups: 3, tier2_mnc: 1, max_contacts_per_company: 5 },
    hierarchy: daily.contact_hierarchy || [],
    experienceRange: daily.experience_range || '0-2',
    locationPriority: (daily.location_priority || []).sort((a, b) => a.tier - b.tier),
  };
}

function loadTemplates() {
  if (!existsSync(TEMPLATES_PATH)) throw new Error(`Missing ${TEMPLATES_PATH}`);
  const text = readFileSync(TEMPLATES_PATH, 'utf-8');
  const sections = {};
  const headerRe = /^## Tier (\d+):\s*(.+)$/gm;
  const codeRe = /```\n([\s\S]*?)\n```/;
  const parts = text.split(/^## Tier /m).slice(1);
  for (const part of parts) {
    const firstLine = part.split('\n', 1)[0];
    const tierNum = firstLine.split(':', 1)[0].trim();
    const block = codeRe.exec(part);
    if (!block) continue;
    const tierName = mapTierNumToName(tierNum);
    sections[tierName] = block[1].trim();
  }
  return sections;
}

function mapTierNumToName(n) {
  const map = { 1: 'HR', 2: 'TeamLead', 3: 'Developer', 4: 'Manager', 5: 'Founder' };
  return map[n] || null;
}

// -----------------------------------------------------------------------------
// Dedup sets
// -----------------------------------------------------------------------------

function buildDedupSets() {
  const companies = new Set();
  const emails = new Set();
  const blockedStatuses = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'skip', 'discarded']);

  if (existsSync(HISTORY_PATH)) {
    const lines = readFileSync(HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.startsWith('|') || line.startsWith('|---') || line.startsWith('| #')) continue;
      const cols = line.split('|').map((c) => c.trim());
      // cols: ['', '#', 'Date', 'QueueID', 'To', 'Company', 'Role', 'Subject', 'Result', 'Notes', '']
      const email = (cols[4] || '').toLowerCase();
      const company = (cols[5] || '').toLowerCase();
      if (email) emails.add(email);
      if (company) companies.add(company);
    }
  }

  if (existsSync(APPS_PATH)) {
    const lines = readFileSync(APPS_PATH, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.startsWith('|') || line.startsWith('|---') || line.startsWith('| #')) continue;
      const cols = line.split('|').map((c) => c.trim());
      // cols: ['', '#', 'Date', 'Company', 'Role', 'Score', 'Status', 'PDF', 'Report', 'Notes', '']
      const company = (cols[3] || '').toLowerCase();
      const status = (cols[6] || '').toLowerCase().replace(/[*_]/g, '');
      if (company && blockedStatuses.has(status)) {
        companies.add(company);
      }
    }
  }

  return { companies, emails };
}

// -----------------------------------------------------------------------------
// Claude -p subprocess
// -----------------------------------------------------------------------------

function callClaude(prompt, { timeoutMs = 300000 } = {}) {
  const res = spawnSync('claude', ['-p', prompt], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (res.error) {
    throw new Error(`claude subprocess error: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`claude subprocess exit ${res.status}: ${res.stderr}`);
  }
  return res.stdout || '';
}

function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0) throw new Error('No JSON object found in claude output.');
  const slice = candidate.slice(firstBrace, lastBrace + 1);
  return JSON.parse(slice);
}

// -----------------------------------------------------------------------------
// Stage 1: Discover companies
// -----------------------------------------------------------------------------

function discoverCompanies(queries, count, excluded, tierLabel, locationLabel, experienceRange) {
  if (count <= 0 || queries.length === 0) return [];

  const excludedList = [...excluded].slice(0, 200).join(', ') || '(none)';
  const queryList = queries
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    .map((q, i) => `${i + 1}. [${q.platform}] ${q.query}`)
    .join('\n');

  const prompt = `You are a job search automation agent. Run WebSearch queries from this priority list until you have found exactly ${count} NEW companies hiring for software developer or data analyst roles.

Priority list:
${queryList}

Excluded companies (do NOT include any of these): ${excludedList}

Requirements per company (ALL must be satisfied):
- Must have a live job listing URL (careers page or job board)
- Must be hiring NOW for: Full Stack Developer, Backend Developer, Node.js, MERN, SDE, or Data Analyst
- Experience required: ${experienceRange} years — fresher or junior level eligible (do NOT return roles requiring 3+ years)
- Location type: ${locationLabel}
- Prefer ${tierLabel}

Return strict JSON only (no prose, no markdown fences other than optional \`\`\`json):

{
  "companies": [
    {
      "name": "Company Name",
      "role": "Full Stack Developer",
      "jd_url": "https://...",
      "platform": "cutshort",
      "location_type": "remote" | "hybrid" | "offline",
      "stack_hints": ["Node.js", "MongoDB"]
    }
  ]
}

Stop as soon as you have ${count} valid companies. Return exactly ${count} (or fewer if platforms exhausted).`;

  console.log(`  → [${locationLabel}] ${count} ${tierLabel} via claude -p ...`);
  const out = callClaude(prompt);
  try {
    const parsed = extractJson(out);
    const companies = Array.isArray(parsed.companies) ? parsed.companies : [];
    return companies.filter((c) => c.name && !excluded.has(c.name.toLowerCase()));
  } catch (err) {
    console.error(`  ⚠ Failed to parse claude output: ${err.message}`);
    console.error(`  Raw output:\n${out.slice(0, 500)}`);
    return [];
  }
}

function discoverWithLocationWaterfall(allQueries, quota, excluded, tierLabel, locationPriority, experienceRange) {
  if (quota <= 0) return [];
  const found = [];
  const foundNames = new Set([...excluded]);

  for (const locTier of locationPriority) {
    const remaining = quota - found.length;
    if (remaining <= 0) break;
    const queries = allQueries.filter((q) => (q.location_tier || 2) === locTier.tier);
    if (queries.length === 0) continue;
    const batch = discoverCompanies(queries, remaining, foundNames, tierLabel, locTier.label, experienceRange);
    for (const c of batch) {
      found.push({ ...c, location_label: locTier.label });
      foundNames.add(c.name.toLowerCase());
    }
    if (found.length >= quota) break;
  }
  return found;
}

// -----------------------------------------------------------------------------
// Stage 2: Discover contacts per company
// -----------------------------------------------------------------------------

function discoverContacts(company, hierarchy, excludedEmails) {
  const hierarchyDesc = hierarchy
    .map((t) => `${t.order}. ${t.tier}: ${(t.search_titles || []).join(', ')}`)
    .join('\n');

  const prompt = `Find 5 contacts at "${company.name}" (one per hierarchy tier). The company is hiring for: ${company.role}.

Hierarchy tiers:
${hierarchyDesc}

For each tier find ONE person. Search priority per contact (stop at first match):
a. VERIFIED public email (from LinkedIn bio, GitHub profile, personal site, speaker bios, blog posts)
b. Hunter.io / Apollo.io / RocketReach / SignalHire / ContactOut indexed verified email (search via WebSearch)
c. Guessed company email pattern — only if you can confirm the email format used by the company

Do NOT include contacts with these emails (already contacted): ${[...excludedEmails].slice(0, 100).join(', ') || '(none)'}

Return strict JSON only (no prose):

{
  "company": "${company.name}",
  "role": "${company.role}",
  "jd_summary": "2-3 sentence technical summary of the role and company",
  "contacts": [
    {
      "tier": "HR",
      "name": "Full Name",
      "email": "addr@domain.tld",
      "confidence": "verified",
      "linkedin_url": "https://linkedin.com/in/..."
    }
  ]
}

Rules:
- Return a contact entry ONLY if you found an email (verified OR confidently guessed from known format)
- Omit tier entirely if no email found (do not include null emails)
- confidence = "verified" if email came from a public page or Hunter/Apollo/RocketReach
- confidence = "guessed" if constructed from a known pattern (e.g., first.last@company.com)
- Skip contact if email is a generic catchall (info@, contact@, support@, hello@)`;

  console.log(`  → Contacts for ${company.name} via claude -p ...`);
  try {
    const out = callClaude(prompt);
    const parsed = extractJson(out);
    const contacts = Array.isArray(parsed.contacts) ? parsed.contacts : [];
    return {
      company: parsed.company || company.name,
      role: parsed.role || company.role,
      jd_summary: parsed.jd_summary || '',
      contacts: contacts.filter(
        (c) =>
          c.email &&
          c.email.includes('@') &&
          !excludedEmails.has(c.email.toLowerCase()) &&
          !/^(info|contact|support|hello|admin|noreply|no-reply)@/i.test(c.email)
      ),
    };
  } catch (err) {
    console.error(`  ⚠ Contact discovery failed for ${company.name}: ${err.message}`);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Stage 3: Tier-specific body rendering
// -----------------------------------------------------------------------------

function firstName(name) {
  if (!name) return 'team';
  const parts = String(name).split(/\s+/);
  return parts[0] || 'team';
}

function stackMatchOf(company) {
  const hints = company.stack_hints || [];
  if (hints.length === 0) return 'Node.js, AWS, and mobile';
  if (hints.length === 1) return hints[0];
  if (hints.length === 2) return hints.join(' and ');
  return `${hints.slice(0, -1).join(', ')}, and ${hints[hints.length - 1]}`;
}

function primaryStackOf(company) {
  const hints = company.stack_hints || [];
  return hints[0] || 'full stack';
}

function renderTierBody(tier, contact, company, templates) {
  const raw = templates[tier] || templates.HR;
  return raw
    .replace(/\{first_name\}/g, firstName(contact.name))
    .replace(/\{company\}/g, company.name)
    .replace(/\{role\}/g, company.role)
    .replace(/\{stack_match\}/g, stackMatchOf(company))
    .replace(/\{primary_stack\}/g, primaryStackOf(company));
}

// -----------------------------------------------------------------------------
// Stage 4: Queue + personalize + validate + approve + send
// -----------------------------------------------------------------------------

function runEmailer(args, env = process.env) {
  const res = spawnSync('node', [join(ROOT, 'emailer.mjs'), ...args], {
    encoding: 'utf-8',
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return res;
}

function readQueueIds() {
  if (!existsSync(QUEUE_PATH)) return [];
  const lines = readFileSync(QUEUE_PATH, 'utf-8').split('\n').slice(1).filter(Boolean);
  return lines.map((l) => l.split('\t')[0]).filter(Boolean);
}

function queueCompany(companyData, templates) {
  writeFileSync(CONTACTO_EXPORT_PATH, JSON.stringify(companyData, null, 2));
  const before = new Set(readQueueIds());
  const res = runEmailer(['queue', '--from-contacto', '--template', 'cold']);
  if (res.status !== 0) {
    console.error(`  ⚠ queue failed: ${res.stderr}`);
    return [];
  }
  const after = readQueueIds();
  const newIds = after.filter((id) => !before.has(id));
  return newIds;
}

function personalizeDraft(id, tier, contact, company, templates) {
  const body = renderTierBody(tier, contact, company, templates);
  const subject = `Application | ${company.role} | Dev Patel`;
  const res = runEmailer(['edit', '--id', id, '--body', body, '--subject', subject]);
  if (res.status !== 0) {
    console.error(`  ⚠ edit id=${id} failed: ${res.stderr}`);
  }
}

function validateAndPrune(ids) {
  if (ids.length === 0) return [];
  const res = runEmailer(['validate', '--ids', ids.join(',')]);
  const out = (res.stdout || '') + (res.stderr || '');
  const failedLine = out.match(/(\d+) valid, (\d+) suspect/);
  if (!failedLine) return ids;
  const suspectCount = Number(failedLine[2]);
  if (suspectCount === 0) return ids;

  const badIdMatches = [...out.matchAll(/✗\s*\[(\d+)\]/g)].map((m) => m[1]);
  if (badIdMatches.length > 0) {
    console.log(`  ⚠ MX failed for IDs: ${badIdMatches.join(',')} — auto-deleting`);
    runEmailer(['delete', '--ids', badIdMatches.join(',')]);
  }
  return ids.filter((id) => !badIdMatches.includes(id));
}

function approveIds(ids) {
  if (ids.length === 0) return false;
  const res = runEmailer(['approve', '--ids', ids.join(','), '--allow_guessed']);
  return res.status === 0;
}

function sendIds(ids) {
  if (ids.length === 0) return { sent: 0, failed: 0 };
  if (!process.env.EMAIL_SMTP_USER || !process.env.EMAIL_SMTP_PASS) {
    throw new Error('EMAIL_SMTP_USER / EMAIL_SMTP_PASS not set — cannot send.');
  }
  const res = runEmailer(['send', '--ids', ids.join(','), '--live', '--confirmed', '--allow_guessed']);
  const out = (res.stdout || '') + (res.stderr || '');
  const sent = (out.match(/SENT \d+ ->/g) || []).length;
  const failed = (out.match(/FAILED \d+ ->/g) || []).length;
  return { sent, failed, out };
}

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function writeLog(report) {
  const path = join(LOG_DIR, `daily-apply-log-${todayDate()}.md`);
  writeFileSync(path, report, 'utf-8');
  console.log(`→ Log written to ${path}`);
}

function buildReport(state) {
  const lines = [];
  lines.push(`# Daily Apply Log — ${todayDate()}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Companies discovered: ${state.discovered}`);
  lines.push(`- Companies skipped (dedup): ${state.skipped}`);
  lines.push(`- Contacts queued: ${state.queued}`);
  lines.push(`- Contacts validated: ${state.validated}`);
  lines.push(`- Emails sent: ${state.sent}`);
  lines.push(`- Emails failed: ${state.failed}`);
  lines.push('');
  lines.push('## Companies');
  lines.push('| Company | Role | Location | Platform | Contacts Queued | Sent |');
  lines.push('|---------|------|----------|----------|-----------------|------|');
  for (const row of state.rows) {
    lines.push(`| ${row.company} | ${row.role} | ${row.location_label || '—'} | ${row.platform} | ${row.queued} | ${row.sent} |`);
  }
  if (state.errors.length) {
    lines.push('');
    lines.push('## Errors');
    for (const e of state.errors) lines.push(`- ${e}`);
  }
  return lines.join('\n') + '\n';
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const flags = args.flags;
  const dryRun = !!flags['dry-run'];
  const limit = flags.limit ? Number(flags.limit) : null;
  const tier1Only = !!flags['tier1-only'];
  const tier2Only = !!flags['tier2-only'];

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  const config = loadConfig();
  const templates = loadTemplates();
  const { companies: excludedCompanies, emails: excludedEmails } = buildDedupSets();

  console.log(`Dedup set: ${excludedCompanies.size} companies, ${excludedEmails.size} emails`);

  const state = {
    discovered: 0,
    skipped: 0,
    queued: 0,
    validated: 0,
    sent: 0,
    failed: 0,
    rows: [],
    errors: [],
  };

  let tier1Quota = tier2Only ? 0 : config.quota.tier1_startups;
  let tier2Quota = tier1Only ? 0 : config.quota.tier2_mnc;
  if (limit !== null) {
    const total = tier1Quota + tier2Quota;
    if (limit < total) {
      tier1Quota = Math.min(tier1Quota, limit);
      tier2Quota = Math.max(0, limit - tier1Quota);
    }
  }

  const allCompanies = [];
  const locPriority = config.locationPriority.length
    ? config.locationPriority
    : [{ tier: 1, label: 'outside India remote' }, { tier: 2, label: 'India remote or hybrid' }, { tier: 3, label: 'Ahmedabad offline' }];

  console.log(`→ Location priority: ${locPriority.map((l) => l.label).join(' → ')}`);
  console.log(`→ Experience target: ${config.experienceRange} years`);

  if (tier1Quota > 0) {
    console.log(`→ Discovering ${tier1Quota} startup(s) ...`);
    const t1 = discoverWithLocationWaterfall(
      config.tier1Queries, tier1Quota, excludedCompanies, 'startups', locPriority, config.experienceRange
    );
    t1.forEach((c) => { allCompanies.push({ ...c, tier: 1 }); excludedCompanies.add(c.name.toLowerCase()); });
  }
  if (tier2Quota > 0) {
    console.log(`→ Discovering ${tier2Quota} Data Analyst MNC(s) ...`);
    const t2 = discoverWithLocationWaterfall(
      config.tier2Queries, tier2Quota, excludedCompanies, 'Data Analyst MNC', locPriority, config.experienceRange
    );
    t2.forEach((c) => allCompanies.push({ ...c, tier: 2 }));
  }

  state.discovered = allCompanies.length;
  if (allCompanies.length === 0) {
    state.errors.push('No companies discovered. All platforms may be exhausted or dedup-blocked.');
    writeLog(buildReport(state));
    return;
  }

  console.log(`Discovered ${allCompanies.length} companies:`);
  allCompanies.forEach((c) => console.log(`  - [T${c.tier}] ${c.name} — ${c.role} (${c.platform})`));

  if (dryRun) {
    console.log('\n--- DRY RUN: skipping contact discovery + send ---');
    state.errors.push('Dry run — no emails queued or sent.');
    writeLog(buildReport(state));
    return;
  }

  for (const company of allCompanies) {
    const contactData = discoverContacts(company, config.hierarchy, excludedEmails);
    if (!contactData || contactData.contacts.length === 0) {
      state.errors.push(`No contacts found for ${company.name} — skipped.`);
      state.rows.push({ company: company.name, role: company.role, location_label: company.location_label, platform: company.platform, queued: 0, sent: 0 });
      continue;
    }

    const newIds = queueCompany(contactData, templates);
    if (newIds.length === 0) {
      state.errors.push(`Queue produced 0 rows for ${company.name}.`);
      continue;
    }

    for (let i = 0; i < newIds.length && i < contactData.contacts.length; i++) {
      const contact = contactData.contacts[i];
      personalizeDraft(newIds[i], contact.tier, contact, company, templates);
      contact.email && excludedEmails.add(contact.email.toLowerCase());
    }

    const validIds = validateAndPrune(newIds);
    state.queued += newIds.length;
    state.validated += validIds.length;

    const approved = approveIds(validIds);
    if (!approved) {
      state.errors.push(`approve failed for ${company.name}`);
      continue;
    }

    const sendResult = sendIds(validIds);
    state.sent += sendResult.sent;
    state.failed += sendResult.failed;
    state.rows.push({
      company: company.name,
      role: company.role,
      location_label: company.location_label,
      platform: company.platform,
      queued: newIds.length,
      sent: sendResult.sent,
    });

    excludedCompanies.add(company.name.toLowerCase());
  }

  writeLog(buildReport(state));
  console.log(`\nDone. Sent ${state.sent}, failed ${state.failed}, queued ${state.queued}.`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});

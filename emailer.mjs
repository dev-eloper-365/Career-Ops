#!/usr/bin/env node
/**
 * emailer.mjs - Outreach email queue + sender for career-ops
 *
 * Commands:
 *   init
 *   status
 *   queue --from-tracker [--template cold|followup|referral]
 *   queue --from-contacto [--from-contacto-file path] [--template cold|followup|referral]
 *   queue --to "Name <email>,email2" --company "Acme" --role "SWE" [--jd "..."] [--subject "..."] [--template cold|followup|referral] [--guessed]
 *   preview [--status drafted,approved,sent,failed] [--full]
 *   validate [--ids 1,2]
 *   edit --id <n> [--body "..."] [--subject "..."] [--to "Name <email>"] [--jd "..."] [--confidence verified|guessed]
 *   approve --ids 1,2|all [--allow_guessed]
 *   retry --ids 1,2|all
 *   delete --ids 1,2
 *   send --ids 1,2|all [--live] [--confirmed] [--allow_guessed]
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolve as dnsResolve } from 'dns/promises';
import yaml from 'js-yaml';
import nodemailer from 'nodemailer';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const PROFILE_PATH = join(ROOT, 'config/profile.yml');
const APPS_PATH = join(ROOT, 'data/applications.md');
const QUEUE_PATH = join(ROOT, 'data/email-queue.tsv');
const HISTORY_PATH = join(ROOT, 'data/email-history.md');
const ATTACHMENT_PATH = join(ROOT, 'DevSDE2026.pdf');
const CONTACTO_EXPORT_PATH = join(ROOT, 'data/contacto-export.json');

const MAX_PER_DAY = 20;
const MIN_SECONDS_BETWEEN_SENDS = 90;

const QUEUE_HEADERS = [
  'id',
  'created_at',
  'source',
  'app_num',
  'company',
  'role',
  'contact_name',
  'email',
  'email_confidence',
  'subject',
  'body',
  'attachment_path',
  'status',
  'attempts',
  'last_error',
  'jd_summary',
];

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function ensureDataFiles() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  if (!existsSync(QUEUE_PATH)) {
    writeFileSync(QUEUE_PATH, `${QUEUE_HEADERS.join('\t')}\n`, 'utf-8');
  }

  if (!existsSync(HISTORY_PATH)) {
    writeFileSync(
      HISTORY_PATH,
      '# Email History\n\n| # | Date | QueueID | To | Company | Role | Subject | Result | Notes |\n|---|------|---------|----|---------|------|---------|--------|-------|\n',
      'utf-8'
    );
  }
}

// Normalize --flag-name to args.flag_name so both hyphens and underscores work
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }

    const key = token.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }

    out[key] = next;
    i += 1;
  }
  return out;
}

function readProfile() {
  if (!existsSync(PROFILE_PATH)) {
    throw new Error('Missing config/profile.yml.');
  }

  const profile = yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
  const candidate = profile.candidate || {};
  return {
    fullName: candidate.full_name || 'Candidate',
    email: candidate.email || '',
  };
}

function readTsv(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return [];

  const lines = raw.split('\n');
  const headers = lines[0].split('\t');
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = line.split('\t');
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] || '';
    });
    return row;
  });
}

function writeTsv(path, headers, rows) {
  const encodeField = (value) => String(value || '').replace(/\t/g, ' ').replace(/\r?\n/g, '\\n');
  const body = [headers.join('\t')]
    .concat(rows.map((row) => headers.map((h) => encodeField(row[h])).join('\t')))
    .join('\n');
  writeFileSync(path, `${body}\n`, 'utf-8');
}

function decodeEscapedNewlines(text) {
  return String(text || '').replace(/\\n/g, '\n');
}

function parseApps() {
  if (!existsSync(APPS_PATH)) return [];
  const content = readFileSync(APPS_PATH, 'utf-8');
  const apps = [];

  for (const line of content.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 10) continue;

    const num = Number(cells[1]);
    if (!Number.isFinite(num)) continue;

    apps.push({
      num,
      date: cells[2],
      company: cells[3],
      role: cells[4],
      score: cells[5],
      status: cells[6],
      pdf: cells[7],
      report: cells[8],
      notes: cells[9] || '',
    });
  }
  return apps;
}

function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase().replace(/\*\*/g, '').trim();
  const aliases = {
    aplicado: 'applied',
    aplicada: 'applied',
    sent: 'applied',
    responded: 'responded',
    respondido: 'responded',
    interview: 'interview',
    entrevista: 'interview',
  };
  return aliases[s] || s;
}

function extractEmailsFromText(text) {
  const matches = String(text || '').match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) || [];
  return [...new Set(matches.map((m) => m.trim().toLowerCase()))];
}

function parseRecipientList(recipientArg) {
  if (!recipientArg) return [];
  const parts = String(recipientArg)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const recipients = [];
  for (const part of parts) {
    const angle = part.match(/^(.*)<([^>]+)>$/);
    if (angle) {
      recipients.push({
        name: angle[1].trim() || 'Hiring Team',
        email: angle[2].trim().toLowerCase(),
      });
      continue;
    }
    recipients.push({ name: 'Hiring Team', email: part.toLowerCase() });
  }
  return recipients;
}

function extractReportPath(reportCell) {
  const m = String(reportCell || '').match(/\]\(([^)]+)\)/);
  if (!m) return null;
  return m[1];
}

function summarizeJdFromReport(reportPath) {
  if (!reportPath) return '';
  const abs = join(ROOT, reportPath);
  if (!existsSync(abs)) return '';

  const text = readFileSync(abs, 'utf-8');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const context = lines.find((l) => /role|responsibilit|mission|company|stack/i.test(l));
  return (context || '').slice(0, 220);
}

function buildSubject(company, role) {
  return `Application follow-up: ${role} at ${company}`;
}

// Template: cold (default) — first outreach
function buildBody({ recipientName, company, role, jdSummary, senderName }) {
  const intro = `Hi ${recipientName || 'Hiring Team'},`;
  const line1 = `I am reaching out regarding the ${role} role at ${company}.`;
  const line2 = jdSummary
    ? `Your job description emphasizes ${jdSummary.replace(/^[-*]\s*/, '')}, and that aligns with my experience building production systems in similar contexts.`
    : `I believe my background is a strong fit for the role and team.`;
  const line3 = 'If useful, I can share concise examples of relevant impact and discuss how I can contribute quickly.';
  const close = `Best,\n${senderName}`;
  return [intro, `${line1}\n${line2}\n${line3}`, close].join('\n\n');
}

// Template: followup — after earlier outreach or application
function buildBodyFollowup({ recipientName, company, role, jdSummary, senderName }) {
  const intro = `Hi ${recipientName || 'Hiring Team'},`;
  const line1 = `Following up on my earlier application for the ${role} role at ${company}.`;
  const line2 = jdSummary
    ? `Given your focus on ${jdSummary.replace(/^[-*]\s*/, '')}, I wanted to reiterate my relevant experience and check on next steps.`
    : 'I remain very interested and wanted to follow up to see if there is any update.';
  const line3 = 'Happy to share additional context or examples if useful.';
  const close = `Best,\n${senderName}`;
  return [intro, `${line1}\n${line2}\n${line3}`, close].join('\n\n');
}

// Template: referral — peer/network approach, no direct ask
function buildBodyReferral({ recipientName, company, role, jdSummary, senderName }) {
  const intro = `Hi ${recipientName || 'there'},`;
  const line1 = `I came across your work at ${company} and noticed the overlap with what I have been building.`;
  const line2 = jdSummary
    ? `Your team is working on ${jdSummary.replace(/^[-*]\s*/, '')}, which maps closely to my recent work in this space.`
    : 'The technical direction at your team aligns closely with my background.';
  const line3 = 'Would love to hear how your team approaches these challenges, not a pitch, just genuinely curious.';
  const close = `Best,\n${senderName}`;
  return [intro, `${line1}\n${line2}\n${line3}`, close].join('\n\n');
}

function buildBodyByTemplate(template, opts) {
  if (template === 'followup') return buildBodyFollowup(opts);
  if (template === 'referral') return buildBodyReferral(opts);
  return buildBody(opts);
}

function nextQueueId(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
}

function queueRowsFromTracker(rows, args, profile) {
  const apps = parseApps().filter((a) => ['applied', 'responded', 'interview'].includes(normalizeStatus(a.status)));
  const existing = new Set(rows.map((r) => `${r.app_num}|${r.email}|${r.subject}`));
  const template = String(args.template || 'cold');

  let nextId = nextQueueId(rows);
  const created = [];

  for (const app of apps) {
    const emails = extractEmailsFromText(app.notes);
    if (emails.length === 0) continue;

    const reportPath = extractReportPath(app.report);
    const jdSummary = summarizeJdFromReport(reportPath);

    for (const email of emails) {
      const subject = buildSubject(app.company, app.role);
      const key = `${app.num}|${email}|${subject}`;
      if (existing.has(key)) continue;

      const row = {
        id: String(nextId++),
        created_at: nowIso(),
        source: 'tracker-notes',
        app_num: String(app.num),
        company: app.company,
        role: app.role,
        contact_name: 'Hiring Team',
        email,
        email_confidence: 'verified',
        subject,
        body: buildBodyByTemplate(template, {
          recipientName: 'Hiring Team',
          company: app.company,
          role: app.role,
          jdSummary,
          senderName: profile.fullName,
        }),
        attachment_path: ATTACHMENT_PATH,
        status: 'drafted',
        attempts: '0',
        last_error: '',
        jd_summary: jdSummary,
      };

      rows.push(row);
      created.push(row);
      existing.add(key);
    }
  }

  return created;
}

function queueManualRows(rows, args, profile) {
  const recipients = parseRecipientList(args.to);
  if (recipients.length === 0) {
    throw new Error('No recipients found. Use --to "Name <email>,email2" or --from-tracker.');
  }

  const company = args.company || 'Unknown Company';
  const role = args.role || 'Unknown Role';
  const jdSummary = String(args.jd || '').slice(0, 220);
  const subject = args.subject || buildSubject(company, role);
  const template = String(args.template || 'cold');

  const existing = new Set(rows.map((r) => `${r.app_num}|${r.email}|${r.subject}`));
  let nextId = nextQueueId(rows);
  const created = [];

  for (const recipient of recipients) {
    const key = `manual|${recipient.email}|${subject}`;
    if (existing.has(key)) continue;

    const confidence = args.guessed ? 'guessed' : 'verified';
    const row = {
      id: String(nextId++),
      created_at: nowIso(),
      source: args.guessed ? 'manual-guessed' : 'manual',
      app_num: 'manual',
      company,
      role,
      contact_name: recipient.name,
      email: recipient.email,
      email_confidence: confidence,
      subject,
      body: buildBodyByTemplate(template, {
        recipientName: recipient.name,
        company,
        role,
        jdSummary,
        senderName: profile.fullName,
      }),
      attachment_path: ATTACHMENT_PATH,
      status: 'drafted',
      attempts: '0',
      last_error: '',
      jd_summary: jdSummary,
    };

    rows.push(row);
    created.push(row);
    existing.add(key);
  }

  return created;
}

// Queue from contacto-export.json written by /career-ops contacto mode
// Format: { company, role, jd_summary, template?, contacts: [{name, email, confidence, type}] }
function queueFromContacto(rows, args, profile) {
  const filePath = args.from_contacto_file
    ? String(args.from_contacto_file)
    : CONTACTO_EXPORT_PATH;

  if (!existsSync(filePath)) {
    throw new Error(
      `Contacto export not found: ${filePath}\nRun /career-ops contacto, then ask Claude to save contacts to data/contacto-export.json`
    );
  }

  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Invalid contacto-export.json: ${err.message}`);
  }

  const company = data.company || 'Unknown Company';
  const role = data.role || 'Unknown Role';
  const jdSummary = String(data.jd_summary || '').slice(0, 220);
  const contacts = Array.isArray(data.contacts) ? data.contacts : [];

  if (contacts.length === 0) {
    throw new Error('No contacts found in contacto-export.json.');
  }

  const template = String(args.template || data.template || 'cold');
  const subject = args.subject || buildSubject(company, role);
  const existing = new Set(rows.map((r) => `${r.app_num}|${r.email}|${r.subject}`));
  let nextId = nextQueueId(rows);
  const created = [];

  for (const contact of contacts) {
    const email = String(contact.email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) {
      console.log(`Skipping contact "${contact.name || 'unknown'}": no valid email.`);
      continue;
    }

    const name = contact.name || 'Hiring Team';
    const confidence = contact.confidence || 'guessed';
    const key = `manual|${email}|${subject}`;
    if (existing.has(key)) continue;

    const row = {
      id: String(nextId++),
      created_at: nowIso(),
      source: `contacto-${confidence}`,
      app_num: 'manual',
      company,
      role,
      contact_name: name,
      email,
      email_confidence: confidence,
      subject,
      body: buildBodyByTemplate(template, {
        recipientName: name,
        company,
        role,
        jdSummary,
        senderName: profile.fullName,
      }),
      attachment_path: ATTACHMENT_PATH,
      status: 'drafted',
      attempts: '0',
      last_error: '',
      jd_summary: jdSummary,
    };

    rows.push(row);
    created.push(row);
    existing.add(key);
  }

  return created;
}

function listRows(rows, states = []) {
  const filtered = states.length > 0 ? rows.filter((r) => states.includes(r.status)) : rows;
  if (filtered.length === 0) {
    console.log('No queue rows matched your filter.');
    return;
  }

  console.log('ID  Status    Confidence  To                          Company           Role');
  console.log('--- --------- ---------- --------------------------- ----------------- --------------------');
  for (const r of filtered) {
    console.log(
      `${String(r.id).padEnd(3)} ${String(r.status).padEnd(9)} ${String(r.email_confidence).padEnd(10)} ${String(r.email).slice(0, 27).padEnd(27)} ${String(r.company).slice(0, 17).padEnd(17)} ${String(r.role).slice(0, 20)}`
    );
  }
}

function listRowsDetailed(rows, states = []) {
  const filtered = states.length > 0 ? rows.filter((r) => states.includes(r.status)) : rows;
  if (filtered.length === 0) {
    console.log('No queue rows matched your filter.');
    return;
  }

  for (const r of filtered) {
    console.log(`\n=== Queue ${r.id} ===`);
    console.log(`Status: ${r.status} | Confidence: ${r.email_confidence}`);
    console.log(`To: ${r.contact_name} <${r.email}>`);
    console.log(`Company: ${r.company} | Role: ${r.role}`);
    console.log(`Subject: ${r.subject}`);
    console.log('--- Body ---');
    console.log(decodeEscapedNewlines(r.body));
    console.log(`Attachment: ${r.attachment_path}`);
    if (r.jd_summary) {
      console.log(`JD Context: ${r.jd_summary}`);
    }
    console.log('---');
  }
}

function parseIds(idsArg, allRows) {
  if (!idsArg || String(idsArg).trim() === '') return [];
  if (idsArg === 'all') return allRows.map((r) => String(r.id));
  return String(idsArg)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function enforceFixedAttachment(row) {
  if (row.attachment_path !== ATTACHMENT_PATH) {
    throw new Error(`Queue ${row.id} violates fixed attachment policy. Expected ${ATTACHMENT_PATH}`);
  }
  if (!existsSync(ATTACHMENT_PATH)) {
    throw new Error(`Missing required attachment: ${ATTACHMENT_PATH}`);
  }
}

function appendHistory(queueId, to, company, role, subject, result, notes) {
  const content = existsSync(HISTORY_PATH) ? readFileSync(HISTORY_PATH, 'utf-8') : '';
  const histRows = content.split('\n').filter((line) => /^\|\s*\d+\s*\|/.test(line));
  const next = histRows.length + 1;
  const safe = (v) => String(v || '').replace(/\|/g, '/');
  appendFileSync(
    HISTORY_PATH,
    `| ${next} | ${todayDate()} | ${safe(queueId)} | ${safe(to)} | ${safe(company)} | ${safe(role)} | ${safe(subject)} | ${safe(result)} | ${safe(notes)} |\n`,
    'utf-8'
  );
}

function sentCountToday() {
  if (!existsSync(HISTORY_PATH)) return 0;
  const today = todayDate();
  const content = readFileSync(HISTORY_PATH, 'utf-8');
  let count = 0;
  for (const row of content.split('\n').filter((line) => line.startsWith('|'))) {
    const cells = row.split('|').map((c) => c.trim());
    if (cells.length < 9) continue;
    if (cells[2] !== today) continue;
    if (String(cells[8]).toLowerCase() === 'sent') count += 1;
  }
  return count;
}

function lastSentTimestamp(rows) {
  const sent = rows
    .filter((r) => r.status === 'sent')
    .map((r) => new Date(r.created_at).getTime())
    .filter((x) => Number.isFinite(x));
  if (sent.length === 0) return null;
  return Math.max(...sent);
}

function assertEnvForLive(profile) {
  const user = process.env.EMAIL_SMTP_USER || '';
  const pass = process.env.EMAIL_SMTP_PASS || '';
  if (!user || !pass) {
    throw new Error('Missing EMAIL_SMTP_USER or EMAIL_SMTP_PASS environment variables.');
  }
  if (profile.email && profile.email !== user) {
    console.log(`Warning: profile email (${profile.email}) differs from EMAIL_SMTP_USER (${user}).`);
  }
  return { user, pass };
}

// Check if same email+company already sent in history (prevent accidental re-send)
function checkHistoryDuplicate(email, company) {
  if (!existsSync(HISTORY_PATH)) return false;
  const content = readFileSync(HISTORY_PATH, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // | # | Date | QueueID | To | Company | Role | Subject | Result | Notes |
    if (cells.length < 9) continue;
    if (
      cells[4].toLowerCase() === email.toLowerCase() &&
      cells[5].toLowerCase() === company.toLowerCase() &&
      cells[8].toLowerCase() === 'sent'
    ) {
      return true;
    }
  }
  return false;
}

// DNS MX record check — validates domain can receive email
async function validateEmailDomain(email) {
  const parts = String(email || '').split('@');
  if (parts.length !== 2 || !parts[1]) return { valid: false, reason: 'malformed address' };
  const domain = parts[1];
  try {
    const mx = await dnsResolve(domain, 'MX');
    if (mx && mx.length > 0) return { valid: true, reason: `${mx.length} MX record(s)` };
    return { valid: false, reason: 'domain exists but no MX records' };
  } catch (err) {
    if (err.code === 'ENOTFOUND') return { valid: false, reason: 'domain not found' };
    if (err.code === 'ENODATA') return { valid: false, reason: 'no DNS data for domain' };
    return { valid: false, reason: err.code || String(err.message) };
  }
}

async function validateGuessedEmails(rows, args) {
  const idFilter = args.ids ? parseIds(args.ids, rows) : null;
  const candidates = rows.filter((r) => {
    if (r.email_confidence !== 'guessed') return false;
    if (r.status === 'sent') return false;
    if (idFilter && !idFilter.includes(String(r.id))) return false;
    return true;
  });

  if (candidates.length === 0) {
    console.log('No unvalidated guessed emails found.');
    return rows;
  }

  console.log(`\nValidating ${candidates.length} guessed email domain(s)...\n`);
  let valid = 0;
  let invalid = 0;

  for (const row of candidates) {
    const result = await validateEmailDomain(row.email);
    const mark = result.valid ? '✓' : '✗';
    console.log(`${mark} [${row.id}] ${row.email} (${row.company}) — ${result.reason}`);
    if (!result.valid) {
      row.last_error = `domain check: ${result.reason}`;
      invalid++;
    } else {
      if (row.last_error && row.last_error.startsWith('domain check:')) row.last_error = '';
      valid++;
    }
  }

  console.log(`\nResult: ${valid} valid, ${invalid} suspect.`);
  if (invalid > 0) {
    console.log('Suspect rows flagged in last_error. Use "delete --ids <n>" to remove them.');
  }
  return rows;
}

function editRow(rows, args) {
  const id = String(args.id || '');
  if (!id) throw new Error('Provide --id <n>');

  const row = rows.find((r) => String(r.id) === id);
  if (!row) throw new Error(`Queue ID ${id} not found.`);
  if (row.status === 'sent') throw new Error(`Queue ${id} already sent. Cannot edit sent rows.`);

  let changed = 0;

  if (args.body !== undefined) {
    row.body = String(args.body).replace(/\n/g, '\\n');
    console.log(`Updated body for queue ${id}.`);
    changed++;
  }
  if (args.subject !== undefined) {
    row.subject = String(args.subject);
    console.log(`Updated subject for queue ${id}.`);
    changed++;
  }
  if (args.to !== undefined) {
    const recip = parseRecipientList(args.to)[0];
    if (recip) {
      row.email = recip.email;
      row.contact_name = recip.name;
      console.log(`Updated recipient for queue ${id}: ${recip.name} <${recip.email}>`);
      changed++;
    }
  }
  if (args.jd !== undefined) {
    row.jd_summary = String(args.jd).slice(0, 220);
    console.log(`Updated JD context for queue ${id}.`);
    changed++;
  }
  if (args.confidence !== undefined) {
    if (!['verified', 'guessed'].includes(args.confidence)) {
      throw new Error('--confidence must be "verified" or "guessed".');
    }
    row.email_confidence = args.confidence;
    console.log(`Updated confidence for queue ${id}: ${args.confidence}`);
    changed++;
  }

  if (changed === 0) {
    throw new Error('No editable fields provided. Use --body, --subject, --to, --jd, --confidence.');
  }

  // Content edits require re-approval
  if (row.status === 'approved' && (args.body !== undefined || args.subject !== undefined)) {
    row.status = 'drafted';
    console.log(`Status reset to drafted (re-approval required after content edit).`);
  }

  return rows;
}

function showStatus(rows) {
  const counts = { drafted: 0, approved: 0, sent: 0, failed: 0, other: 0 };
  for (const r of rows) {
    if (counts[r.status] !== undefined) counts[r.status]++;
    else counts.other++;
  }

  const todayCount = sentCountToday();
  const remaining = Math.max(0, MAX_PER_DAY - todayCount);

  console.log('\nEmail Queue Status');
  console.log('==================');
  console.log(`Drafted:  ${counts.drafted}`);
  console.log(`Approved: ${counts.approved}`);
  console.log(`Sent:     ${counts.sent}`);
  console.log(`Failed:   ${counts.failed}`);
  console.log(`Total:    ${rows.length}`);
  console.log('');
  console.log(`Today: ${todayCount}/${MAX_PER_DAY} sent (${remaining} remaining)`);

  if (counts.failed > 0) {
    const failedIds = rows.filter((r) => r.status === 'failed').map((r) => r.id).join(', ');
    console.log(`\nFailed IDs: ${failedIds}`);
    console.log('Fix: node emailer.mjs retry --ids <ids>');
  }
  if (counts.approved > 0) {
    const ready = rows
      .filter((r) => r.status === 'approved')
      .map((r) => `${r.id}(${r.company})`)
      .join(', ');
    console.log(`\nReady to send: ${ready}`);
  }
}

function retryRows(rows, args) {
  const ids = parseIds(args.ids, rows);
  if (ids.length === 0) throw new Error('No IDs provided. Use --ids 1,2 or --ids all.');

  let updated = 0;
  for (const row of rows) {
    if (!ids.includes(String(row.id))) continue;
    if (row.status !== 'failed') {
      console.log(`Skipping ${row.id}: status is ${row.status}, expected failed.`);
      continue;
    }
    row.status = 'approved';
    row.last_error = '';
    updated++;
    console.log(`Reset queue ${row.id} (${row.company}) → approved.`);
  }

  console.log(`\nRetry-queued ${updated} item(s).`);
  return rows;
}

function deleteRows(rows, args) {
  const ids = parseIds(args.ids, rows);
  if (ids.length === 0) throw new Error('No IDs provided. Use --ids 1,2.');

  for (const r of rows.filter((row) => ids.includes(String(row.id)))) {
    if (r.status === 'sent') {
      throw new Error(`Cannot delete queue ${r.id}: already sent. Sent rows are permanent record.`);
    }
  }

  const deleted = rows.filter((r) => ids.includes(String(r.id)));
  const kept = rows.filter((r) => !ids.includes(String(r.id)));
  console.log(`Deleted ${deleted.length} row(s): ${deleted.map((r) => `${r.id}(${r.company})`).join(', ')}`);
  return kept;
}

async function sendRows(rows, args, profile) {
  const ids = parseIds(args.ids, rows);
  if (ids.length === 0) throw new Error('No queue IDs selected. Use --ids 1,2 or --ids all.');

  const selected = rows.filter((r) => ids.includes(String(r.id)));
  if (selected.length === 0) throw new Error('No matching queue IDs.');

  const isLive = Boolean(args.live);
  const isConfirmed = Boolean(args.confirmed);
  const allowGuessed = Boolean(args.allow_guessed);
  const todayCount = sentCountToday();

  if (todayCount >= MAX_PER_DAY) {
    throw new Error(`Daily cap reached: ${todayCount}/${MAX_PER_DAY}. Try tomorrow.`);
  }

  const sendable = selected.filter((r) => {
    if (r.status !== 'approved') return false;
    if (r.email_confidence === 'guessed' && !allowGuessed) return false;
    return true;
  });

  // Always show full draft previews before live send — gate on --confirmed
  if (isLive) {
    if (sendable.length === 0) {
      console.log('No approved rows ready to send. Check status and approval first.');
      return rows;
    }

    console.log('\n=== Pre-Send Draft Review ===');
    listRowsDetailed(sendable, []);

    if (!isConfirmed) {
      console.log('\n---');
      console.log(`${sendable.length} email(s) ready to send. Review drafts above.`);
      console.log('Re-run with --confirmed to proceed with live send.');
      return rows;
    }
  }

  let transporter = null;
  if (isLive) {
    const creds = assertEnvForLive(profile);
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: creds.user, pass: creds.pass },
    });
  }

  const lastSentAt = lastSentTimestamp(rows);
  if (lastSentAt) {
    const elapsedSec = Math.floor((Date.now() - lastSentAt) / 1000);
    if (elapsedSec < MIN_SECONDS_BETWEEN_SENDS) {
      throw new Error(
        `Rate limit guard: wait ${MIN_SECONDS_BETWEEN_SENDS - elapsedSec}s more before next send.`
      );
    }
  }

  let sentNow = 0;

  for (const row of selected) {
    if (row.status !== 'approved') {
      console.log(`Skipping ${row.id}: status=${row.status}, expected approved.`);
      continue;
    }

    if (row.email_confidence === 'guessed' && !allowGuessed) {
      console.log(`Skipping ${row.id}: guessed email requires --allow_guessed.`);
      continue;
    }

    enforceFixedAttachment(row);

    if (todayCount + sentNow >= MAX_PER_DAY) {
      console.log(`Daily cap reached while processing queue ${row.id}.`);
      break;
    }

    // Warn on duplicate but proceed — user approved it
    if (checkHistoryDuplicate(row.email, row.company)) {
      console.log(`⚠  Duplicate warning: ${row.email} at ${row.company} already in send history.`);
    }

    const from = profile.email || process.env.EMAIL_SMTP_USER || '';
    if (!from) {
      throw new Error('Sender email missing. Set candidate.email in profile or EMAIL_SMTP_USER.');
    }

    if (!isLive) {
      console.log(`DRY RUN ${row.id} -> ${row.email} | ${row.subject}`);
      appendHistory(row.id, row.email, row.company, row.role, row.subject, 'DRY_RUN', 'No network send');
      continue;
    }

    try {
      const info = await transporter.sendMail({
        from,
        to: row.email,
        subject: row.subject,
        text: decodeEscapedNewlines(row.body),
        attachments: [{ filename: 'DevSDE2026.pdf', path: ATTACHMENT_PATH }],
      });

      row.status = 'sent';
      row.attempts = String((Number(row.attempts) || 0) + 1);
      row.last_error = '';
      row.created_at = nowIso();
      sentNow += 1;
      appendHistory(row.id, row.email, row.company, row.role, row.subject, 'sent', info.messageId || 'ok');
      console.log(`SENT ${row.id} -> ${row.email}`);
    } catch (err) {
      row.status = 'failed';
      row.attempts = String((Number(row.attempts) || 0) + 1);
      row.last_error = String(err.message || err);
      appendHistory(row.id, row.email, row.company, row.role, row.subject, 'failed', row.last_error);
      console.log(`FAILED ${row.id} -> ${row.email}: ${row.last_error}`);
    }
  }

  return rows;
}

function approveRows(rows, args) {
  const ids = parseIds(args.ids, rows);
  if (ids.length === 0) throw new Error('No IDs provided. Use --ids 1,2 or --ids all.');

  let updated = 0;
  for (const row of rows) {
    if (!ids.includes(String(row.id))) continue;
    if (row.status === 'sent') continue;
    if (row.email_confidence === 'guessed' && !args.allow_guessed) {
      continue;
    }
    row.status = 'approved';
    updated += 1;
  }

  console.log(`Approved ${updated} queue item(s).`);
  return rows;
}

function printHelp() {
  console.log(`
emailer.mjs commands:
  init
  status
  queue --from-tracker [--template cold|followup|referral]
  queue --from-contacto [--from-contacto-file path] [--template cold|followup|referral]
  queue --to "Name <email>,email2" --company "Acme" --role "SWE" [--jd "..."] [--subject "..."] [--template cold|followup|referral] [--guessed]
  preview [--status drafted,approved,sent,failed] [--full]
  validate [--ids 1,2]
  edit --id <n> [--body "..."] [--subject "..."] [--to "Name <email>"] [--jd "..."] [--confidence verified|guessed]
  approve --ids 1,2|all [--allow_guessed]
  retry --ids 1,2|all
  delete --ids 1,2
  send --ids 1,2|all [--live] [--confirmed] [--allow_guessed]

Notes:
  - Live send always shows full drafts first. Add --confirmed to proceed.
  - validate checks MX DNS records for guessed email domains.
  - Templates: cold (default, first outreach), followup, referral (peer/network).
  - --from-contacto reads data/contacto-export.json (written by /career-ops contacto).
    Format: { company, role, jd_summary, template?, contacts: [{name, email, confidence, type}] }
  - Duplicate history: warns if same email+company already sent. Does not block.

Environment for live Gmail SMTP:
  EMAIL_SMTP_USER=your@gmail.com
  EMAIL_SMTP_PASS=<gmail app password>

Policy:
  - Fixed attachment only: DevSDE2026.pdf
  - Dry-run by default (omit --live)
  - Guessed recipients require explicit --allow_guessed
  - Daily cap: ${MAX_PER_DAY}, min spacing: ${MIN_SECONDS_BETWEEN_SENDS}s
`);
}

async function main() {
  ensureDataFiles();

  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (!existsSync(ATTACHMENT_PATH)) {
    throw new Error(`Required resume missing: ${ATTACHMENT_PATH}`);
  }

  const profile = readProfile();
  let queueRows = readTsv(QUEUE_PATH);

  if (command === 'init') {
    console.log('Emailer storage initialized.');
    return;
  }

  if (command === 'status') {
    showStatus(queueRows);
    return;
  }

  if (command === 'queue') {
    let created = [];
    if (args.from_tracker) {
      created = queueRowsFromTracker(queueRows, args, profile);
    } else if (args.from_contacto || args.from_contacto_file) {
      created = queueFromContacto(queueRows, args, profile);
    } else {
      created = queueManualRows(queueRows, args, profile);
    }

    writeTsv(QUEUE_PATH, QUEUE_HEADERS, queueRows);
    console.log(`Queued ${created.length} draft email(s).`);
    listRows(created);
    return;
  }

  if (command === 'preview') {
    const states = args.status
      ? String(args.status).split(',').map((x) => x.trim()).filter(Boolean)
      : [];
    if (args.full) {
      listRowsDetailed(queueRows, states);
    } else {
      listRows(queueRows, states);
    }
    return;
  }

  if (command === 'validate') {
    const updated = await validateGuessedEmails(queueRows, args);
    writeTsv(QUEUE_PATH, QUEUE_HEADERS, updated);
    return;
  }

  if (command === 'edit') {
    editRow(queueRows, args);
    writeTsv(QUEUE_PATH, QUEUE_HEADERS, queueRows);
    return;
  }

  if (command === 'approve') {
    const updated = approveRows(queueRows, args);
    writeTsv(QUEUE_PATH, QUEUE_HEADERS, updated);
    return;
  }

  if (command === 'retry') {
    const updated = retryRows(queueRows, args);
    writeTsv(QUEUE_PATH, QUEUE_HEADERS, updated);
    return;
  }

  if (command === 'delete') {
    const kept = deleteRows(queueRows, args);
    writeTsv(QUEUE_PATH, QUEUE_HEADERS, kept);
    return;
  }

  if (command === 'send') {
    const updated = await sendRows(queueRows, args, profile);
    writeTsv(QUEUE_PATH, QUEUE_HEADERS, updated);
    return;
  }

  printHelp();
}

main().catch((err) => {
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});

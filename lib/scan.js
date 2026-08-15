'use strict';
// Discovery layer: reads Claude Code state off disk. No writes happen here.
//
// Two independent stores are joined:
//   1. CLI transcripts  <configDir>/projects/<slug>/<cliSessionId>.jsonl
//   2. Desktop registry %APPDATA%/Claude/claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json
// The desktop record is the only place `isArchived` and the user-set title live.
// It links to a transcript via its `cliSessionId` field.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

const CONFIG_DIRS = [
  { key: 'default', dir: path.join(HOME, '.claude') },
  { key: 'work', dir: path.join(HOME, '.claude-work') },
  { key: 'personal', dir: path.join(HOME, '.claude-personal') },
];

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Transcripts run to tens of MB. Reading them whole makes a refresh take minutes,
// so we sample the head (cwd + opening prompt) and the tail (latest title/prompt).
// Title and last-prompt records are rewritten throughout a session, so the tail
// reliably carries the current values.
function sampleFile(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const headLen = Math.min(HEAD_BYTES, size);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);

    let tail = null;
    if (size > headLen) {
      const tailLen = Math.min(TAIL_BYTES, size);
      const buf = Buffer.alloc(tailLen);
      fs.readSync(fd, buf, 0, tailLen, size - tailLen);
      tail = buf;
    }
    return { head: head.toString('utf8'), tail: tail ? tail.toString('utf8') : null };
  } finally {
    fs.closeSync(fd);
  }
}

function lines(text, dropFirstPartial) {
  if (!text) return [];
  const out = text.split('\n');
  if (dropFirstPartial) out.shift(); // chunk boundary can bisect a line
  return out.filter((l) => l.length > 2);
}

const WRAPPER_RE = /^\s*<(local-command|command-name|command-message|system-reminder)/;

function extractPrompt(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((c) => c && c.type === 'text');
    return t ? t.text : null;
  }
  return null;
}

function parseTranscript(file, stat) {
  const meta = {
    cliSessionId: path.basename(file, '.jsonl'),
    file,
    sizeBytes: stat.size,
    modified: stat.mtime.toISOString(),
    cwd: null,
    title: null,
    firstPrompt: null,
    lastPrompt: null,
  };

  let sample;
  try {
    sample = sampleFile(file, stat.size);
  } catch {
    return meta;
  }

  for (const line of lines(sample.head, false)) {
    if (!meta.cwd && line.includes('"cwd":"')) {
      const o = safeParse(line);
      if (o && o.cwd) meta.cwd = o.cwd;
    }
    if (!meta.firstPrompt && line.includes('"role":"user"')) {
      const o = safeParse(line);
      const t = o && o.message ? extractPrompt(o.message.content) : null;
      if (t && t.trim().length > 3 && !WRAPPER_RE.test(t) && !/^\s*Caveat: The messages below/.test(t)) {
        meta.firstPrompt = t.replace(/\s+/g, ' ').trim();
      }
    }
    if (!meta.title && line.includes('"custom-title"')) {
      const o = safeParse(line);
      if (o && o.customTitle) meta.title = o.customTitle;
    }
  }

  // Tail wins: it holds the most recent title and prompt.
  for (const line of lines(sample.tail, true)) {
    if (line.includes('"custom-title"')) {
      const o = safeParse(line);
      if (o && o.customTitle) meta.title = o.customTitle;
    } else if (line.includes('"last-prompt"')) {
      const o = safeParse(line);
      if (o && o.lastPrompt) meta.lastPrompt = o.lastPrompt.replace(/\s+/g, ' ').trim();
    }
  }
  return meta;
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function scanTranscripts(configKey, configDir) {
  const projects = path.join(configDir, 'projects');
  if (!fs.existsSync(projects)) return [];
  const out = [];
  for (const slug of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(projects, slug.name);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;
      const meta = parseTranscript(file, stat);
      meta.config = configKey;
      meta.slug = slug.name;
      out.push(meta);
    }
  }
  return out;
}

// Identity for each config dir, so the UI can show when two dirs are actually
// the same paying account (which is easy to get wrong).
function readAccounts() {
  const accounts = {};
  for (const { key, dir } of CONFIG_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const cfg = readJson(path.join(dir, '.claude.json')) || {};
    const creds = readJson(path.join(dir, '.credentials.json')) || {};
    const oa = cfg.oauthAccount || {};
    const co = creds.claudeAiOauth || {};
    accounts[key] = {
      key,
      dir,
      exists: true,
      email: oa.emailAddress || null,
      displayName: oa.displayName || null,
      accountUuid: oa.accountUuid || null,
      organizationUuid: oa.organizationUuid || null,
      subscriptionType: co.subscriptionType || null,
      rateLimitTier: oa.organizationRateLimitTier || co.rateLimitTier || null,
      organizationType: oa.organizationType || null,
    };
  }
  // Flag config dirs that share one subscription.
  const byAccount = {};
  for (const a of Object.values(accounts)) {
    if (!a.accountUuid) continue;
    (byAccount[a.accountUuid] = byAccount[a.accountUuid] || []).push(a.key);
  }
  for (const a of Object.values(accounts)) {
    a.sharesAccountWith = (byAccount[a.accountUuid] || []).filter((k) => k !== a.key);
  }
  return accounts;
}

// Config dirs are an implementation detail; what the user thinks in is
// subscriptions. Several config dirs can be one paying account.
function buildSubscriptions(accounts, sessions) {
  const subs = new Map();
  for (const a of Object.values(accounts)) {
    const id = a.accountUuid || `nosub:${a.key}`;
    if (!subs.has(id)) {
      subs.set(id, {
        id,
        email: a.email,
        displayName: a.displayName,
        subscriptionType: a.subscriptionType,
        rateLimitTier: a.rateLimitTier,
        configDirs: [],
        sessionCount: 0,
      });
    }
    const s = subs.get(id);
    s.configDirs.push(a.key);
    if (!s.subscriptionType && a.subscriptionType) s.subscriptionType = a.subscriptionType;
  }
  for (const sess of sessions) {
    const sub = [...subs.values()].find((s) => s.configDirs.includes(sess.config));
    if (sub) {
      sess.subscription = sub.id;
      sub.sessionCount++;
    }
  }
  // Writes land in whichever config dir already holds the most sessions.
  for (const s of subs.values()) {
    s.primaryConfig = s.configDirs
      .slice()
      .sort((x, y) => sessions.filter((k) => k.config === y).length - sessions.filter((k) => k.config === x).length)[0];
    s.label = `${s.displayName || s.email || s.id.slice(0, 8)} · ${s.subscriptionType || '?'}`;
  }
  return [...subs.values()];
}

function desktopStoreRoot() {
  const appdata = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  return path.join(appdata, 'Claude', 'claude-code-sessions');
}

function scanDesktopRegistry() {
  const root = desktopStoreRoot();
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const acct of fs.readdirSync(root, { withFileTypes: true })) {
    if (!acct.isDirectory()) continue;
    const acctDir = path.join(root, acct.name);
    for (const org of fs.readdirSync(acctDir, { withFileTypes: true })) {
      if (!org.isDirectory()) continue;
      const orgDir = path.join(acctDir, org.name);
      let files;
      try {
        files = fs.readdirSync(orgDir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
        const o = readJson(path.join(orgDir, name));
        if (!o) continue;
        out.push({
          desktopSessionId: o.sessionId || path.basename(name, '.json'),
          cliSessionId: o.cliSessionId || null,
          title: o.title || null,
          titleSource: o.titleSource || null,
          isArchived: !!o.isArchived,
          cwd: o.cwd || null,
          branch: o.branch || null,
          model: o.model || null,
          effort: o.effort || null,
          completedTurns: o.completedTurns || 0,
          createdAt: o.createdAt || null,
          lastActivityAt: o.lastActivityAt || null,
          accountUuid: acct.name,
          organizationUuid: org.name,
          registryFile: path.join(orgDir, name),
        });
      }
    }
  }
  return out;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// <configDir>/sessions/<pid>.json registers only LIVE processes.
function scanRunning() {
  const running = new Map();
  for (const { key, dir } of CONFIG_DIRS) {
    const sdir = path.join(dir, 'sessions');
    if (!fs.existsSync(sdir)) continue;
    for (const name of fs.readdirSync(sdir)) {
      if (!name.endsWith('.json')) continue;
      const o = readJson(path.join(sdir, name));
      if (!o || !o.sessionId) continue;
      const alive = o.pid ? pidAlive(o.pid) : false;
      if (alive) running.set(o.sessionId, { pid: o.pid, config: key, cwd: o.cwd, name: o.name });
    }
  }
  return running;
}

function buildIndex() {
  const accounts = readAccounts();
  const registry = scanDesktopRegistry();
  const running = scanRunning();

  const byCli = new Map();
  for (const r of registry) if (r.cliSessionId) byCli.set(r.cliSessionId, r);

  // Fallback join for transcripts whose cliSessionId rotated (compaction/fork):
  // match on exact title + cwd.
  const byTitleCwd = new Map();
  const byCwd = new Map();
  for (const r of registry) {
    if (r.title && r.cwd) byTitleCwd.set(`${r.title} ${r.cwd.toLowerCase()}`, r);
    if (r.cwd) {
      const k = r.cwd.toLowerCase();
      if (!byCwd.has(k)) byCwd.set(k, []);
      byCwd.get(k).push(r);
    }
  }

  const HOUR = 3600e3;
  // A desktop session stores only its CURRENT cliSessionId, but compaction and
  // forks rotate that id — so earlier transcripts of the same conversation match
  // nothing and fall back to their opening prompt (the stale "initial" name).
  // Rescue: same folder, and the transcript was last written inside that desktop
  // session's own lifetime. Requiring the window to contain the timestamp stops
  // unrelated sessions being glued together just for sharing a directory.
  function matchByCwdWindow(cwd, modifiedMs) {
    if (!cwd) return null;
    const cands = byCwd.get(cwd.toLowerCase());
    if (!cands || !cands.length) return null;
    const inWindow = cands.filter(
      (r) =>
        r.createdAt && r.lastActivityAt && modifiedMs >= r.createdAt - HOUR && modifiedMs <= r.lastActivityAt + HOUR
    );
    if (!inWindow.length) return null;
    return inWindow.sort(
      (a, b) => Math.abs(modifiedMs - a.lastActivityAt) - Math.abs(modifiedMs - b.lastActivityAt)
    )[0];
  }

  const sessions = [];
  for (const { key, dir } of CONFIG_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const t of scanTranscripts(key, dir)) {
      let reg = byCli.get(t.cliSessionId) || null;
      let matchedBy = reg ? 'cliSessionId' : null;
      if (!reg && t.title && t.cwd) {
        reg = byTitleCwd.get(`${t.title} ${t.cwd.toLowerCase()}`) || null;
        if (reg) matchedBy = 'title+cwd';
      }
      if (!reg) {
        reg = matchByCwdWindow(t.cwd, new Date(t.modified).getTime());
        if (reg) matchedBy = 'cwd+time';
      }
      // A locally set title is newer than whatever the desktop last wrote, so it
      // wins; otherwise the desktop registry is the display name of record.
      const displayTitle = t.title || (reg && reg.title) || null;
      const live = running.get(t.cliSessionId) || null;
      sessions.push({
        cliSessionId: t.cliSessionId,
        config: key,
        title: displayTitle,
        titleSource: t.title ? 'transcript' : reg && reg.title ? 'desktop' : null,
        label: displayTitle || (t.firstPrompt ? `~ ${t.firstPrompt.slice(0, 70)}` : '(untitled)'),
        isArchived: reg ? reg.isArchived : null, // null = unknown to the desktop app
        isRunning: !!live,
        runningPid: live ? live.pid : null,
        cwd: t.cwd || (reg && reg.cwd) || null,
        branch: reg ? reg.branch : null,
        model: reg ? reg.model : null,
        completedTurns: reg ? reg.completedTurns : null,
        lastPrompt: t.lastPrompt || t.firstPrompt || null,
        sizeBytes: t.sizeBytes,
        modified: t.modified,
        lastActivityAt: reg && reg.lastActivityAt ? new Date(reg.lastActivityAt).toISOString() : t.modified,
        slug: t.slug,
        file: t.file,
        desktopSessionId: reg ? reg.desktopSessionId : null,
        registryMatchedBy: matchedBy,
      });
    }
  }

  // A session that moved between worktrees leaves a transcript under each project
  // slug it lived in. Those are the same conversation, so collapse them and keep
  // the largest (most complete) file as the one we would act on.
  const merged = new Map();
  for (const s of sessions) {
    const key = `${s.config}::${s.cliSessionId}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...s, copies: 1, otherSlugs: [] });
    } else {
      prev.copies++;
      if (s.sizeBytes > prev.sizeBytes) {
        const keptSlug = prev.slug;
        Object.assign(prev, s, { copies: prev.copies, otherSlugs: [...prev.otherSlugs, keptSlug] });
      } else {
        prev.otherSlugs.push(s.slug);
      }
    }
  }

  const deduped = [...merged.values()];
  deduped.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  const subscriptions = buildSubscriptions(accounts, deduped);
  return {
    accounts,
    subscriptions,
    sessions: deduped,
    registryCount: registry.length,
    runningCount: running.size,
    transcriptFiles: sessions.length,
    desktopAppRunning: isDesktopAppRunning(),
  };
}

// The desktop app keeps session metadata in memory and does not re-read its
// registry files, so a registry title edit is invisible (and liable to be
// overwritten) while it is running. Callers use this to gate that write.
let _desktopProbe = { at: 0, value: null };
function isDesktopAppRunning() {
  // Cheap cache: this gates a write and gets called per rename and per scan.
  if (_desktopProbe.value !== null && Date.now() - _desktopProbe.at < 3000) return _desktopProbe.value;
  const { execSync } = require('child_process');
  let value;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /NH', { encoding: 'utf8', timeout: 10000 });
    value = /claude\.exe/i.test(out);
  } catch {
    // Fail safe, not fail open: if we cannot tell, assume it IS running so the
    // registry write is skipped. Guessing "not running" risks writing under a
    // live app that would overwrite it anyway.
    value = true;
  }
  _desktopProbe = { at: Date.now(), value };
  return value;
}

module.exports = { buildIndex, readAccounts, CONFIG_DIRS, scanRunning, isDesktopAppRunning };

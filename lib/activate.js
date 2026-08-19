'use strict';
// "Activation" — making a moved session visible in the Claude Desktop app.
//
// Moving a transcript is enough for `claude --resume`, which reads the .jsonl
// directly. The desktop app does not: it lists sessions from its own registry at
// %APPDATA%/Claude/claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json,
// and only under the account it is signed into. A session moved between config
// dirs keeps its transcript but leaves its registry record behind in the old
// account, so the app shows nothing.
//
// This writes the missing record into the destination account's directory. The
// record is cloned from a real one in the same directory so the schema stays
// whatever the installed app version expects, rather than a guess that goes
// stale on the next app update.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { buildIndex, isDesktopAppRunning } = require('./scan');

function orgDirFor(accountUuid, organizationUuid) {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Claude', 'claude-code-sessions', accountUuid, organizationUuid);
}

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

// Prefer a template from the same directory: same app version, same shape.
function pickTemplate(orgDir) {
  if (!fs.existsSync(orgDir)) return null;
  let names;
  try {
    names = fs.readdirSync(orgDir);
  } catch {
    return null;
  }
  const files = names
    .filter((n) => n.startsWith('local_') && n.endsWith('.json'))
    .map((n) => {
      const full = path.join(orgDir, n);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const f of files) {
    const o = readJson(f.full);
    if (o && o.sessionId && o.cliSessionId) return o;
  }
  return null;
}

const MINIMAL = {
  permissionMode: 'default',
  effort: 'medium',
  model: null,
  sessionSettings: {},
  enabledMcpTools: {},
  remoteMcpServersConfig: [],
  spawnSeed: { worktreeHookBased: false },
};

function activate({ cliSessionId, config, force = false }) {
  const index = buildIndex();
  const session = index.sessions.find((s) => s.cliSessionId === cliSessionId && s.config === config);
  if (!session) throw new Error(`Session ${cliSessionId} not found in "${config}".`);

  const account = index.accounts[config];
  if (!account || !account.accountUuid || !account.organizationUuid) {
    throw new Error(`Config dir "${config}" has no signed-in account, so there is no registry to write to.`);
  }

  if (session.desktopVisible && !force) {
    return {
      ok: true,
      alreadyActive: true,
      cliSessionId,
      config,
      recordFile: session.desktopRecordFile,
      message: 'Already registered in this account. If the app still does not list it, restart Claude Desktop.',
    };
  }

  const orgDir = orgDirFor(account.accountUuid, account.organizationUuid);
  fs.mkdirSync(orgDir, { recursive: true });

  const template = pickTemplate(orgDir);
  const record = template ? JSON.parse(JSON.stringify(template)) : { ...MINIMAL };

  let stat;
  try {
    stat = fs.statSync(session.file);
  } catch {
    throw new Error(`Transcript file is missing: ${session.file}`);
  }
  const lastActivity = Math.round(stat.mtimeMs);
  const created = Math.round(Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs));

  // Identity and per-session state must never be inherited from the template.
  const desktopSessionId = `local_${crypto.randomUUID()}`;
  Object.assign(record, {
    sessionId: desktopSessionId,
    cliSessionId,
    cwd: session.cwd || record.cwd || null,
    originCwd: session.cwd || record.originCwd || null,
    branch: session.branch || null,
    title: session.title || session.label || 'Imported session',
    titleSource: 'user',
    isArchived: false,
    createdAt: created,
    lastActivityAt: lastActivity,
    lastFocusedAt: lastActivity,
    completedTurns: session.completedTurns || 0,
    prs: [],
    writtenBranches: [],
    bridgeSessionIds: [],
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
  });
  if (session.model) record.model = session.model;

  const outFile = path.join(orgDir, `${desktopSessionId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2), 'utf8');

  const running = isDesktopAppRunning();
  return {
    ok: true,
    alreadyActive: false,
    cliSessionId,
    config,
    account: { email: account.email, accountUuid: account.accountUuid },
    desktopSessionId,
    recordFile: outFile,
    clonedSchemaFrom: template ? template.sessionId : null,
    desktopAppRunning: running,
    message: running
      ? 'Registered. Claude Desktop caches its session list in memory — quit and reopen it to see this session.'
      : 'Registered. It will appear the next time Claude Desktop starts.',
  };
}

module.exports = { activate };

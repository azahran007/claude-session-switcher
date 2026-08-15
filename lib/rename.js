'use strict';
// Renaming a session, and why it writes where it writes.
//
// Claude Code stores the display name as a `custom-title` record appended to the
// transcript, and rewrites that record as the session goes. Appending a fresh one
// is therefore the native mechanism, not a hack — it is what the CLI /resume
// picker reads, and the last one in the file wins.
//
// The desktop app keeps its own copy in
// %APPDATA%/Claude/claude-code-sessions/**/local_*.json. Verified on 2026-08-14:
// editing that file while the app is running changes nothing the app reports —
// it holds session state in memory. So that write is gated on the app being
// closed, and is best-effort even then.

const fs = require('fs');
const path = require('path');
const { findTranscript } = require('./move');
const { isDesktopAppRunning } = require('./scan');

const MAX_TITLE = 200;

function setTitle({ cliSessionId, config, title, updateDesktop = true }) {
  const clean = String(title == null ? '' : title).replace(/[\r\n\t]/g, ' ').trim();
  if (!clean) throw new Error('Title cannot be empty.');
  if (clean.length > MAX_TITLE) throw new Error(`Title must be ${MAX_TITLE} characters or fewer.`);

  const src = findTranscript(config, cliSessionId);
  if (!src) throw new Error(`Session ${cliSessionId} not found in "${config}".`);

  // Append, never rewrite: the transcript may be huge and is append-only by design.
  const record = JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId: cliSessionId });
  const needsNewline = (() => {
    const size = fs.statSync(src.file).size;
    if (size === 0) return false;
    const fd = fs.openSync(src.file, 'r');
    try {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      return b.toString('utf8') !== '\n';
    } finally {
      fs.closeSync(fd);
    }
  })();
  fs.appendFileSync(src.file, (needsNewline ? '\n' : '') + record + '\n', 'utf8');

  const result = {
    ok: true,
    cliSessionId,
    config,
    title: clean,
    transcriptUpdated: true,
    desktopUpdated: false,
    desktopSkippedReason: null,
  };

  if (updateDesktop) {
    const desktopAppRunning = isDesktopAppRunning();
    if (desktopAppRunning) {
      result.desktopSkippedReason =
        'Claude Desktop is running. It caches session metadata in memory and would ignore — and likely overwrite — ' +
        'a change written to its registry file. Quit Claude Desktop and rename again to update the name it shows.';
    } else {
      const reg = findRegistryRecord(cliSessionId);
      if (!reg) {
        result.desktopSkippedReason = 'No desktop registry record is linked to this transcript.';
      } else {
        try {
          const o = JSON.parse(fs.readFileSync(reg, 'utf8'));
          o.title = clean;
          o.titleSource = 'user';
          fs.writeFileSync(reg, JSON.stringify(o, null, 2), 'utf8');
          result.desktopUpdated = true;
          result.desktopFile = reg;
        } catch (e) {
          result.desktopSkippedReason = `Could not write registry record: ${e.message}`;
        }
      }
    }
  }

  return result;
}

function desktopStoreRoot() {
  const appdata = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'Claude', 'claude-code-sessions');
}

function findRegistryRecord(cliSessionId) {
  const root = desktopStoreRoot();
  if (!fs.existsSync(root)) return null;
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
        const file = path.join(orgDir, name);
        try {
          const o = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (o.cliSessionId === cliSessionId) return file;
        } catch {
          /* ignore unreadable record */
        }
      }
    }
  }
  return null;
}

module.exports = { setTitle };

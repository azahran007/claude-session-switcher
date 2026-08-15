'use strict';
// The only module that writes. Every guard here exists because of a way this
// can silently destroy work:
//   - a running session has a live process appending to the file; two writers corrupt it
//   - an existing destination means the two copies have already diverged
//   - moving out from under a desktop-app registry entry orphans that entry
//
// A transcript carries no account identity, so relocating the .jsonl into another
// config dir is all that is required to resume it under that account's credentials.

const fs = require('fs');
const path = require('path');
const { CONFIG_DIRS, scanRunning } = require('./scan');

function configDirFor(key) {
  const c = CONFIG_DIRS.find((c) => c.key === key);
  if (!c) throw new Error(`Unknown account key: ${key}`);
  return c.dir;
}

function findTranscript(configKey, cliSessionId) {
  const projects = path.join(configDirFor(configKey), 'projects');
  if (!fs.existsSync(projects)) return null;
  for (const slug of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const candidate = path.join(projects, slug.name, `${cliSessionId}.jsonl`);
    if (fs.existsSync(candidate)) return { file: candidate, slug: slug.name };
  }
  return null;
}

function transfer({ cliSessionId, from, to, mode = 'copy', force = false }) {
  if (from === to) throw new Error('Source and destination are the same account.');
  if (!['copy', 'move'].includes(mode)) throw new Error(`Invalid mode: ${mode}`);

  const src = findTranscript(from, cliSessionId);
  if (!src) throw new Error(`Session ${cliSessionId} not found in "${from}".`);

  const running = scanRunning();
  if (running.has(cliSessionId)) {
    const r = running.get(cliSessionId);
    throw new Error(
      `Session is RUNNING (pid ${r.pid}). Close it first — a live process is appending to this transcript ` +
        `and moving it now risks corrupting the file.`
    );
  }

  const dstDir = path.join(configDirFor(to), 'projects', src.slug);
  const dst = path.join(dstDir, `${cliSessionId}.jsonl`);

  if (fs.existsSync(dst) && !force) {
    throw new Error(
      `Already present in "${to}". Those two copies have diverged independently — ` +
        `delete the one you do not want, then retry.`
    );
  }

  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src.file, dst);

  let removedSource = false;
  if (mode === 'move') {
    // Copy-then-verify-then-unlink: never unlink before the destination is intact.
    const a = fs.statSync(src.file).size;
    const b = fs.statSync(dst).size;
    if (a !== b) {
      fs.unlinkSync(dst);
      throw new Error(`Copy verification failed (${a} vs ${b} bytes). Source left untouched.`);
    }
    fs.unlinkSync(src.file);
    removedSource = true;
  }

  return {
    ok: true,
    mode,
    from,
    to,
    cliSessionId,
    source: src.file,
    destination: dst,
    removedSource,
    resumeCommand: `claude-resume-session ${cliSessionId} -Account ${to}`,
  };
}

module.exports = { transfer, findTranscript };

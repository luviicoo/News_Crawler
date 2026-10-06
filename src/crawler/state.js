'use strict';

const fs = require('fs');
const path = require('path');

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}

// An append-only journal saves discoveries BEFORE queries are marked done and
// saves accepted rows BEFORE CSV output. Resume rebuilds CSV from this journal.
function openState(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let lockFd;
  try {
    lockFd = fs.openSync(lock, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid crawl lock: ${lock}`);
    let alive = true;
    try { process.kill(pid, 0); } catch (check) { if (check.code === 'ESRCH') alive = false; }
    if (alive) throw new Error(`Crawl already running (PID ${pid}): ${file}`);
    fs.unlinkSync(lock);
    lockFd = fs.openSync(lock, 'wx');
  }
  fs.writeFileSync(lockFd, String(process.pid));
  fs.closeSync(lockFd);
  let fd;
  const queries = new Map();
  const candidates = new Map();
  let header;
  const apply = event => {
    if (event.type === 'config') header = event.value;
    if (event.type === 'query') {
      for (const card of event.cards || []) {
        const current = candidates.get(card.id);
        if (!current) candidates.set(card.id, { ...card, status: 'pending', attempts: 0 });
        else if (!current.rssPublishDate && card.rssPublishDate) {
          current.rssPublishDate = card.rssPublishDate;
          // A later feed can supply a missing publication date.
          if (current.status === 'date-unverified') current.status = 'pending';
        }
      }
      queries.set(event.id, event.value);
    }
    if (event.type === 'candidate') {
      if (!candidates.has(event.id)) throw new Error(`Unknown candidate in journal: ${event.id}`);
      Object.assign(candidates.get(event.id), event.value);
    }
  };
  try {
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      const end = bytes.lastIndexOf(10) + 1;
      // A crash may leave an incomplete final record, but never ignore malformed
      // complete records: that would silently drop accepted rows.
      const lines = bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) apply(JSON.parse(line));
      if (header && JSON.stringify(header) !== JSON.stringify(config)) {
        throw new Error('Checkpoint options differ. Use a different --state path for a different crawl plan.');
      }
      if (end !== bytes.length) fs.truncateSync(file, end);
    }
    fd = fs.openSync(file, 'a');
    const record = event => {
      fs.writeSync(fd, JSON.stringify(event) + '\n');
      fs.fsyncSync(fd);
      apply(event);
    };
    if (!header) record({ type: 'config', value: config });
    return {
      queries, candidates, record,
      close() { fs.closeSync(fd); fs.unlinkSync(lock); },
    };
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.unlinkSync(lock);
    throw err;
  }
}

// Identities of accepted articles in another checkpoint, read without locking
// it, so a separate (e.g. daily) crawl can avoid re-adding those articles.
function readAcceptedIdentities(file) {
  if (!fs.existsSync(file)) throw new Error(`Dedupe checkpoint not found: ${file}`);
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const event = JSON.parse(line);
      return event.type === 'candidate' && event.value?.identity ? [event.value.identity] : [];
    } catch (_) {
      return []; // A concurrently written final line may be incomplete.
    }
  });
}

module.exports = { openState, atomicJson, readAcceptedIdentities };

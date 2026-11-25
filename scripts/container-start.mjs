// Container entry point (Dockerfile CMD).
//
// Persistent volumes are frequently mounted root-owned (Railway always does it; so do Docker bind
// mounts), and an unprivileged process cannot write there. So the container starts as root ONLY to
// make DATA_DIR writable for the unprivileged user, then drops privileges for good and starts the
// server. The application itself never runs as root.
//
//   started as root      → mkdir/chown DATA_DIR → setgid/setuid to RUN_AS_USER ("node") → server
//   started as non-root  → (docker run --user …) nothing to fix, the server starts right away
import fs from 'node:fs';
import path from 'node:path';

const RUN_AS = process.env.RUN_AS_USER || 'node';
const dataDir = path.resolve(process.env.DATA_DIR || './data');

/** uid/gid/home of a system user from /etc/passwd (no native modules, no extra packages). */
function lookupUser(name) {
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const [user, , uid, gid, , home] = line.split(':');
      if (user === name) return { uid: Number(uid), gid: Number(gid), home };
    }
  } catch { /* no passwd file */ }
  return null;
}

function chownTree(target, uid, gid) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.uid !== uid || stat.gid !== gid) fs.chownSync(target, uid, gid);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) chownTree(path.join(target, entry), uid, gid);
  }
}

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  const user = lookupUser(RUN_AS);
  if (!user || user.uid === 0) {
    console.warn(`[start] user "${RUN_AS}" not found — staying root`);
  } else {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      chownTree(dataDir, user.uid, user.gid);
    } catch (err) {
      console.warn(`[start] cannot prepare ${dataDir}: ${err.message}`);
    }
    try {
      process.initgroups(RUN_AS, user.gid);
      process.setgid(user.gid);
      process.setuid(user.uid);
      if (user.home) process.env.HOME = user.home;
      console.log(`[start] data dir ${dataDir} is ready, running as ${RUN_AS} (uid ${user.uid})`);
    } catch (err) {
      console.warn(`[start] cannot drop privileges (${err.message}) — staying root`);
    }
  }
}

await import('../src/server.js');

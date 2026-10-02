import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../../config/env.js';

const run = promisify(execFile);

export const BACKUP_DIR = path.resolve(env.BACKUP_DIR);
export const BACKUP_NAME = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.tar\.gz$/;

export async function listBackups() {
  await mkdir(BACKUP_DIR, { recursive: true });
  const names = (await readdir(BACKUP_DIR)).filter((n) => BACKUP_NAME.test(n));
  const rows = await Promise.all(
    names.map(async (name) => {
      const s = await stat(path.join(BACKUP_DIR, name));
      return { name, size: s.size, createdAt: s.mtime };
    }),
  );
  return rows.sort((a, b) => b.name.localeCompare(a.name));
}

let running: Promise<{ name: string; size: number; createdAt: Date }> | null = null;

/**
 * One archive per backup: the database (mongodump) + the uploaded attachments.
 * Restore: tar -xzf <file>, then `mongorestore --gzip --archive=db.archive --drop` and copy uploads/ back.
 * Needs mongodump and tar on the server. Keeps the newest BACKUP_KEEP archives.
 */
export function createBackup() {
  running ??= (async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const name = `backup-${stamp}.tar.gz`;
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'techloop-backup-'));
    try {
      await mkdir(BACKUP_DIR, { recursive: true });
      await run('mongodump', [`--uri=${env.MONGODB_URI}`, '--gzip', `--archive=${tmp}/db.archive`]);
      const uploads = path.resolve(env.UPLOAD_DIR);
      await mkdir(uploads, { recursive: true });
      await run('tar', [
        '-czf',
        path.join(BACKUP_DIR, name),
        '-C',
        tmp,
        'db.archive',
        '-C',
        path.dirname(uploads),
        path.basename(uploads),
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    const all = await listBackups();
    for (const old of all.slice(Math.max(env.BACKUP_KEEP, 1))) {
      await rm(path.join(BACKUP_DIR, old.name), { force: true });
    }
    return all.find((b) => b.name === name)!;
  })().finally(() => {
    running = null;
  });
  return running;
}

/**
 * Daily backup: checks every hour and backs up once a day (UTC date in the file name).
 * ponytail: in-process timer, fine for one server; use cron if the API ever runs as several instances.
 */
export function scheduleBackups() {
  if (env.BACKUP_KEEP === 0) return;
  const check = async () => {
    try {
      const today = `backup-${new Date().toISOString().slice(0, 10)}`;
      if (!(await listBackups()).some((b) => b.name.startsWith(today))) await createBackup();
    } catch (err) {
      console.error('Backup failed:', err);
    }
  };
  setTimeout(check, 60_000); // let the server start first
  setInterval(check, 60 * 60_000).unref();
}

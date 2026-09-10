import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLibraryPath, containerMounts } from './paths.js';

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-paths-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Real shape from a running container (fields: id parent major:minor root target …). */
const MOUNTINFO = `525 524 0:158 / / rw,relatime - overlay overlay rw,lowerdir=/x
526 525 0:161 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
531 525 0:164 / /sys/fs/cgroup ro,nosuid - cgroup2 cgroup rw
532 525 253:1 /media/books/ebooks /library/ebooks ro,relatime - ext4 /dev/sda1 ro
533 525 253:1 /media/books/audiobooks /library/audiobooks ro,relatime - ext4 /dev/sda1 ro
534 525 253:1 /srv/vx/data /data rw,relatime - ext4 /dev/sda1 rw
535 525 253:1 /srv/vx/models /models rw,relatime - ext4 /dev/sda1 rw
536 525 0:161 /bus /proc/bus ro,nosuid - proc proc rw
537 525 253:1 /srv/vx/hosts /etc/hosts rw,relatime - ext4 /dev/sda1 rw
`;

describe('containerMounts', () => {
  it('reports the directories a container has mounted, skipping pseudo and file mounts', () => {
    const info = path.join(tmp, 'mountinfo');
    fs.writeFileSync(info, MOUNTINFO);
    for (const d of ['/library/ebooks', '/library/audiobooks', '/data', '/models']) {
      fs.mkdirSync(path.join(tmp, 'root', d), { recursive: true });
    }
    // The parser statfs()es each target, so run it against real directories by
    // rewriting the targets into the temp tree.
    const rewritten = MOUNTINFO.split('\n')
      .map((line) => {
        const f = line.split(' ');
        if (f.length > 4 && f[4]!.startsWith('/library')) f[4] = path.join(tmp, 'root', f[4]!);
        else if (f.length > 4 && (f[4] === '/data' || f[4] === '/models'))
          f[4] = path.join(tmp, 'root', f[4]!);
        return f.join(' ');
      })
      .join('\n');
    fs.writeFileSync(info, rewritten);

    const all = containerMounts([], info);
    expect(all).toContain(path.join(tmp, 'root/library/ebooks'));
    expect(all).toContain(path.join(tmp, 'root/library/audiobooks'));
    expect(all).toContain(path.join(tmp, 'root/data'));
    // Pseudo filesystems and single-file bind mounts never appear.
    expect(all.some((m) => m.startsWith('/proc') || m.startsWith('/sys'))).toBe(false);
    expect(all).not.toContain('/etc/hosts');
    expect(all).not.toContain('/');

    // The app's own volumes can be excluded so they are not offered as libraries.
    const libsOnly = containerMounts(
      [path.join(tmp, 'root/data'), path.join(tmp, 'root/models')],
      info,
    );
    expect(libsOnly).not.toContain(path.join(tmp, 'root/data'));
    expect(libsOnly).toContain(path.join(tmp, 'root/library/ebooks'));
  });

  it('returns nothing when mountinfo is unavailable (plain host run)', () => {
    expect(containerMounts([], path.join(tmp, 'no-such-file'))).toEqual([]);
  });
});

describe('checkLibraryPath', () => {
  it('reports readable folders with a match count, and names the problem otherwise', () => {
    const good = path.join(tmp, 'lib');
    fs.mkdirSync(path.join(good, 'Author'), { recursive: true });
    fs.writeFileSync(path.join(good, 'Author', 'a.epub'), 'x');
    const ok = checkLibraryPath(good, 'ebook');
    expect(ok).toMatchObject({ ok: true, exists: true, isDirectory: true, matches: 1 });
    expect(ok.problem).toBeNull();

    const missing = checkLibraryPath(path.join(tmp, 'nope'), 'ebook');
    expect(missing).toMatchObject({ ok: false, exists: false });
    expect(missing.problem).toMatch(/does not exist/i);

    const file = path.join(tmp, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(checkLibraryPath(file)).toMatchObject({ ok: false, isDirectory: false });

    // Readable but empty: still usable, with an honest warning.
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const e = checkLibraryPath(empty, 'audio');
    expect(e.ok).toBe(true);
    expect(e.matches).toBe(0);
    expect(e.problem).toMatch(/no audio files/i);
  });
});

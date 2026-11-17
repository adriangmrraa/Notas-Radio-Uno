/**
 * Tests del slice PJ-05 (Épica J): `S3BackupStorage` — driver S3 del
 * BackupStorage con client fake (sin red, sin SDK real ni credenciales).
 *
 * Cubre:
 *   - writeFile/readFile/statFile/exists/deleteFile-equivalente via
 *     deletePrefix (list + delete paginado).
 *   - Guard anti path-traversal en TODAS las operaciones (misma regla
 *     que el fs adapter: vacías, NUL, absolutas, backslash, `..`).
 *   - publicPath → URI `s3://bucket/prefix/key` (documentado: no es ruta
 *     local ni URL firmada).
 *   - statFile 404/NotFound → null; otros errores propagan.
 *   - S3_PREFIX se antepone a las keys del bucket.
 *   - Constructor sin bucket → throw descriptivo.
 */
import { describe, expect, it } from 'vitest';

import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import {
  S3BackupStorage,
  type S3LikeClient,
} from '../src/server/services/s3BackupStorage';

const BUCKET = 'test-bucket';

/** Client fake: bucket en memoria { key → {data, mtime} }. */
function makeFakeS3() {
  const objects = new Map<string, { data: Buffer; mtime: Date }>();
  const sent: unknown[] = [];
  const listingSnapshots = new Map<string, string[]>();

  const client: S3LikeClient = {
    async send(command: unknown): Promise<unknown> {
      sent.push(command);
      if (command instanceof PutObjectCommand) {
        const { Key, Body } = (command as PutObjectCommand).input;
        objects.set(Key as string, {
          data: Buffer.isBuffer(Body) ? Body : Buffer.from(Body as Uint8Array),
          mtime: new Date('2026-11-17T10:00:00Z'),
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const { Key } = (command as GetObjectCommand).input;
        const obj = objects.get(Key as string);
        if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: obj.data };
      }
      if (command instanceof HeadObjectCommand) {
        const { Key } = (command as HeadObjectCommand).input;
        const obj = objects.get(Key as string);
        if (!obj) {
          const err = new Error('NotFound') as Error & {
            $metadata?: { httpStatusCode: number };
          };
          err.name = 'NotFound';
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return { ContentLength: obj.data.length, LastModified: obj.mtime };
      }
      if (command instanceof ListObjectsV2Command) {
        const { Prefix, ContinuationToken } = (command as ListObjectsV2Command).input;
        // Snapshot al primer call por prefijo — el cursor real de S3 no
        // re-evalúa el listing contra deletes que ocurren mid-iteración.
        if (!ContinuationToken) {
          listingSnapshots.set(
            Prefix as string,
            [...objects.keys()].filter((k) => k.startsWith(Prefix as string)).sort(),
          );
        }
        const all = listingSnapshots.get(Prefix as string) ?? [];
        const start = ContinuationToken ? Number(ContinuationToken) : 0;
        const page = all.slice(start, start + 2); // páginas de 2 para probar paginado
        return {
          Contents: page.map((Key) => ({ Key })),
          NextContinuationToken:
            start + 2 < all.length ? String(start + 2) : undefined,
        };
      }
      if (command instanceof DeleteObjectsCommand) {
        const { Objects } = (command as DeleteObjectsCommand).input.Delete ?? { Objects: [] };
        for (const o of Objects ?? []) if (o.Key) objects.delete(o.Key);
        return {};
      }
      throw new Error(`comando inesperado: ${(command as object).constructor.name}`);
    },
  };
  return { client, objects, sent };
}

const makeStorage = (extra: Record<string, unknown> = {}) => {
  const { client, objects, sent } = makeFakeS3();
  const storage = new S3BackupStorage({ client, bucket: BUCKET, ...extra });
  return { storage, objects, sent };
};

describe('S3BackupStorage', () => {
  it('writeFile + readFile + exists + statFile round-trip', async () => {
    const { storage } = makeStorage();
    await storage.writeFile('tenant-a/clips/clip-1.mp4', Buffer.from('video-bytes'));

    expect(await storage.exists('tenant-a/clips/clip-1.mp4')).toBe(true);
    expect(await storage.exists('tenant-a/otro.mp4')).toBe(false);
    expect((await storage.readFile('tenant-a/clips/clip-1.mp4')).toString()).toBe('video-bytes');

    const stat = await storage.statFile('tenant-a/clips/clip-1.mp4');
    expect(stat?.size).toBe('video-bytes'.length);
    expect(stat?.mtimeMs).toBe(new Date('2026-11-17T10:00:00Z').getTime());
  });

  it('statFile → null ante NotFound/404; otros errores propagan', async () => {
    const { storage } = makeStorage();
    expect(await storage.statFile('nada.mp4')).toBeNull();

    const boom: S3LikeClient = {
      send: () => Promise.reject(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })),
    };
    const s2 = new S3BackupStorage({ client: boom, bucket: BUCKET });
    await expect(s2.statFile('x.mp4')).rejects.toThrow('AccessDenied');
  });

  it('deletePrefix borra todo bajo el prefijo (paginado incluido)', async () => {
    const { storage, objects } = makeStorage();
    for (const name of ['a/1.bin', 'a/2.bin', 'a/3.bin', 'a/4.bin', 'b/keep.bin']) {
      await storage.writeFile(name, Buffer.from(name));
    }
    await storage.deletePrefix('a');
    expect([...objects.keys()].sort()).toEqual(['b/keep.bin']);
  });

  it('S3_PREFIX antepone el prefijo a las keys del bucket', async () => {
    const { storage, objects } = makeStorage({ prefix: 'mirror/prod' });
    await storage.writeFile('t/c.mp4', Buffer.from('x'));
    expect(objects.has('mirror/prod/t/c.mp4')).toBe(true);
    expect(storage.publicPath('t/c.mp4')).toBe(`s3://${BUCKET}/mirror/prod/t/c.mp4`);
  });

  it('publicPath devuelve el URI s3:// (no ruta local)', () => {
    const { storage } = makeStorage();
    expect(storage.publicPath('t/x.mp4')).toBe(`s3://${BUCKET}/t/x.mp4`);
  });

  it('rechaza keys con path traversal antes de tocar el bucket', async () => {
    const { storage, sent } = makeStorage();
    for (const bad of ['', 'a/../b', '../escape', '/abs', 'C:\\win', 'a\\b', 'x\0y', 'a//b']) {
      await expect(storage.writeFile(bad, Buffer.from('x'))).rejects.toThrow();
      await expect(storage.readFile(bad)).rejects.toThrow();
      await expect(storage.statFile(bad)).rejects.toThrow();
      expect(storage.publicPath.bind(storage, bad)).toThrow();
    }
    // Ninguna request llegó al "bucket".
    expect(sent.length).toBe(0);
  });

  it('deletePrefix rechaza prefijos con .. / absoluto / backslash', async () => {
    const { storage } = makeStorage();
    for (const bad of ['../x', '/abs', 'a\\b', 'x/../y']) {
      await expect(storage.deletePrefix(bad)).rejects.toThrow();
    }
  });

  it('sin bucket → throw descriptivo en el constructor', () => {
    delete process.env.S3_BUCKET;
    expect(() => new S3BackupStorage({ client: { send: () => Promise.resolve({}) } })).toThrow(
      /S3_BUCKET/,
    );
  });
});

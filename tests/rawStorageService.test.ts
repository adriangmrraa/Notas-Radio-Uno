/**
 * Tests del slice PD-01: `FilesystemRawStorage` (`src/server/services/rawStorageService.ts`).
 *
 * Cada test corre sobre un tmpdir real (os.tmpdir() + fs.mkdtemp), nunca sobre
 * `data/` ni `output/` del repo. Cubre el round-trip de archivos, statFile,
 * exists, deleteFile, deletePrefix con aislamiento entre prefijos, el rechazo
 * de path traversal (obligatorio) y publicPath bajo la raíz.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilesystemRawStorage } from '../src/server/services/rawStorageService';

const pathExists = (p: string) =>
  access(p)
    .then(() => true)
    .catch(() => false);

describe('FilesystemRawStorage', () => {
  let root: string;
  let storage: FilesystemRawStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'raw-storage-'));
    storage = new FilesystemRawStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writeFile + readFile hacen round-trip del buffer', async () => {
    const data = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x7f]);
    await storage.writeFile('tenant-a/tx-1/seg-00001.mp4', data);
    const back = await storage.readFile('tenant-a/tx-1/seg-00001.mp4');
    expect(back.equals(data)).toBe(true);
  });

  it('appendFile agrega bytes al final del archivo', async () => {
    await storage.writeFile('tenant-a/tx-1/seg.mp4', Buffer.from('abc'));
    await storage.appendFile('tenant-a/tx-1/seg.mp4', Buffer.from('def'));
    expect((await storage.readFile('tenant-a/tx-1/seg.mp4')).toString()).toBe('abcdef');
  });

  it('statFile devuelve el tamaño correcto y null si no existe', async () => {
    await storage.writeFile('tenant-a/tx-1/seg.mp4', Buffer.alloc(1234));
    expect(await storage.statFile('tenant-a/tx-1/seg.mp4')).toEqual({ size: 1234 });
    expect(await storage.statFile('tenant-a/tx-1/no-existe.mp4')).toBeNull();
  });

  it('exists refleja la presencia del archivo', async () => {
    expect(await storage.exists('tenant-a/seg.mp4')).toBe(false);
    await storage.writeFile('tenant-a/seg.mp4', Buffer.from('x'));
    expect(await storage.exists('tenant-a/seg.mp4')).toBe(true);
  });

  it('deleteFile borra el archivo y exists queda en false', async () => {
    await storage.writeFile('tenant-a/seg.mp4', Buffer.from('x'));
    await storage.deleteFile('tenant-a/seg.mp4');
    expect(await storage.exists('tenant-a/seg.mp4')).toBe(false);
    // No falla si ya no existe.
    await storage.deleteFile('tenant-a/seg.mp4');
  });

  it('deletePrefix borra todo el prefijo sin tocar archivos de otro prefijo', async () => {
    await storage.writeFile('tenant-a/tx-1/seg-1.mp4', Buffer.from('1'));
    await storage.writeFile('tenant-a/tx-1/seg-2.mp4', Buffer.from('2'));
    await storage.writeFile('tenant-a/tx-1/nested/seg-3.mp4', Buffer.from('3'));
    await storage.writeFile('tenant-a/tx-2/seg-1.mp4', Buffer.from('otro'));
    await storage.writeFile('tenant-b/tx-1/seg-1.mp4', Buffer.from('vecino'));

    await storage.deletePrefix('tenant-a/tx-1');

    expect(await storage.exists('tenant-a/tx-1/seg-1.mp4')).toBe(false);
    expect(await storage.exists('tenant-a/tx-1/seg-2.mp4')).toBe(false);
    expect(await storage.exists('tenant-a/tx-1/nested/seg-3.mp4')).toBe(false);
    expect(await storage.exists('tenant-a/tx-2/seg-1.mp4')).toBe(true);
    expect(await storage.exists('tenant-b/tx-1/seg-1.mp4')).toBe(true);
    // No falla si el prefijo no existe.
    await storage.deletePrefix('tenant-a/inexistente');
  });

  it('rechaza path traversal y no escribe nada fuera de la raíz', async () => {
    const evilKeys = [
      '../evil.txt',
      '..\\evil.txt',
      'tenant-a/../../evil.txt',
      '/abs/evil.txt',
      '\\\\abs\\evil.txt',
      'C:\\evil.txt',
      '',
      '.',
    ];
    for (const key of evilKeys) {
      await expect(storage.writeFile(key, Buffer.from('boom'))).rejects.toThrow();
    }
    // Nada escrito fuera de la raíz: el padre del tmpdir no tiene evil.txt.
    expect(await pathExists(path.join(root, '..', 'evil.txt'))).toBe(false);
    expect(await pathExists(path.join(tmpdir(), 'evil.txt'))).toBe(false);
    // También readFile/statFile/deletePrefix rechazan traversal.
    await expect(storage.readFile('../evil.txt')).rejects.toThrow();
    await expect(storage.statFile('../evil.txt')).rejects.toThrow();
    await expect(storage.deletePrefix('..')).rejects.toThrow();
  });

  it('publicPath devuelve la ruta absoluta bajo la raíz', async () => {
    const p = storage.publicPath('tenant-a/tx-1/seg-00001.mp4');
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(root + path.sep)).toBe(true);
    expect(p).toBe(path.join(root, 'tenant-a', 'tx-1', 'seg-00001.mp4'));
  });
});

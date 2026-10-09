import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { scriptSourceHash, sha256Hex } from './sha256';

const nodeSha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the FIPS 180 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes UTF-8 bytes and every padding boundary like Node does', () => {
    const samples = ['//@version=6\nstrategy("Ü € 日本")\n', 'x'.repeat(55), 'y'.repeat(56)];
    for (let n = 60; n <= 130; n++) samples.push('z'.repeat(n));
    samples.push('//@version=6\n' + 'plot(close)\n'.repeat(500));
    for (const s of samples) expect(sha256Hex(s)).toBe(nodeSha(s));
  });

  it('gives the engine’s 16-digit script source hash', () => {
    const source = '//@version=6\nstrategy("S")\n';
    expect(scriptSourceHash(source)).toBe(nodeSha(source).slice(0, 16));
    expect(scriptSourceHash(null)).toBe(nodeSha('').slice(0, 16));
  });
});

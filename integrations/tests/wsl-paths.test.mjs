import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWindowsPath, toWslPath, mapPaths } from '../wsl-paths.mjs';
test('mounted drive paths round-trip without rewriting ordinary text', () => {
  assert.equal(toWindowsPath('/mnt/d/my project/中.ts'), 'D:/my project/中.ts');
  assert.equal(toWslPath('D:\\my project\\中.ts'), '/mnt/d/my project/中.ts');
  const message = { params: { cwd: '/mnt/d/repo', prompt: [{ type: 'text', text: '/mnt/d/is/text' }] } };
  assert.deepEqual(mapPaths(message, 'windows'), { params: { cwd: 'D:/repo', prompt: [{ type: 'text', text: '/mnt/d/is/text' }] } });
});
test('file URIs and tool locations map in the return direction', () => {
  assert.deepEqual(mapPaths({ locations: [{ path: 'C:\\code\\a.ts' }], uri: 'file:///D:/my%20project/a.ts' }, 'wsl'), { locations: [{ path: '/mnt/c/code/a.ts' }], uri: 'file:///mnt/d/my%20project/a.ts' });
  assert.equal(toWindowsPath('/home/user/repo'), '/home/user/repo');
  assert.equal(mapPaths({ uri: 'https://example.com/file' }, 'windows').uri, 'https://example.com/file');
});

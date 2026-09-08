import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sectionAtPosition } from '../app/section-navigation.ts';

test('directory tracks all three sections in both scroll directions', () => {
  const sections = scroll => [{ id: 'accounts', top: 140 - scroll }, { id: 'usage', top: 2200 - scroll }, { id: 'devices', top: 3300 - scroll }];
  for (const [scroll, expected] of [[0, 'accounts'], [2100, 'usage'], [3200, 'devices'], [2400, 'usage'], [100, 'accounts']]) {
    assert.equal(sectionAtPosition(sections(scroll), 104), expected);
  }
  assert.equal(sectionAtPosition(sections(100), 104, true), 'devices');
  assert.equal(sectionAtPosition([], 104), null);
  assert.equal(sectionAtPosition([{ id: 'accounts', top: -800 }, { id: 'usage', top: 104.5 }], 104), 'usage');
});
test('dashboard attaches after loading and labels every daily bar', async () => {
  const source = await readFile(new URL('../app/dashboard.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(!authenticated \|\| loading\) return/);
  assert.match(source, /\[authenticated, loading\]/);
  assert.match(source, /removeEventListener\("scroll", schedule\)/);
  assert.match(source, /<time dateTime=\{day.date\}>\{day.label\}<\/time>/);
  assert.match(source, /\[0, 6, 12, 18, 24, 30, 36, 42, 47\]/);
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /html \{[^}]*scroll-padding-top: 104px/);
  assert.doesNotMatch(css, /scroll-margin-top: 104px/);
});

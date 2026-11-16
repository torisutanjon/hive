import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { ContextError } from '../src/context.ts';
import { loadWorkflows, parseWorkflow, render, type Workflow } from '../src/workflow.ts';

const VALID =
  '---\ndescription: Start a ticket\narguments:\n  - name: key\n    description: Ticket key\n    required: true\n  - name: note\n---\nWork on {{key}}.\n';

describe('parseWorkflow', () => {
  test('valid file', () => {
    expect(parseWorkflow('start', VALID)).toMatchObject({
      name: 'start',
      description: 'Start a ticket',
      arguments: [
        { name: 'key', description: 'Ticket key', required: true },
        { name: 'note', required: false },
      ],
      body: 'Work on {{key}}.\n',
    });
  });

  test('CRLF normalised', () => {
    const wf = parseWorkflow('start', VALID.replace(/\n/g, '\r\n'));
    expect(wf.description).toBe('Start a ticket');
    expect(wf.body).toBe('Work on {{key}}.\n');
  });

  test.each([
    ['no frontmatter', 'start', 'just text', /frontmatter/],
    ['bad yaml', 'start', '---\n: bad: [\n---\nx', /YAML/],
    ['no description', 'start', '---\nfoo: 1\n---\nx', /description/],
    ['bad arg name', 'start', "---\ndescription: d\narguments:\n  - name: 'bad name'\n---\nx", /arguments/],
    ['duplicate args', 'start', '---\ndescription: d\narguments:\n  - name: a\n  - name: a\n---\nx', /duplicate/],
    ['bad file name', 'Bad_Name', VALID, /name/],
    ['arguments not a list', 'start', '---\ndescription: d\narguments: notalist\n---\nx', /arguments/],
  ])('rejects %s', (_label, name, text, re) => {
    expect(() => parseWorkflow(name, text)).toThrow(ContextError);
    expect(() => parseWorkflow(name, text)).toThrow(re);
  });

  test('yaml tags are not executed', () => {
    try {
      parseWorkflow('start', '---\ndescription: !!js/function x\n---\nbody');
    } catch (e) {
      expect(e).toBeInstanceOf(ContextError);
    }
  });
});

describe('render', () => {
  const wf: Workflow = {
    name: 'w',
    description: 'd',
    arguments: [
      { name: 'key', required: true },
      { name: 'note', required: false },
    ],
    body: 'A {{key}} B {{ key }} C {{other}} D [{{note}}]',
  };

  test('replaces declared, leaves undeclared, blanks missing optional', () => {
    expect(render(wf, { key: 'K' })).toBe('A K B K C {{other}} D []');
  });

  test('missing required', () => {
    expect(() => render(wf, {})).toThrow(ContextError);
    expect(() => render(wf, {})).toThrow(/missing required argument: key/);
  });

  test('values are not re-rendered', () => {
    expect(render(wf, { key: '{{note}}', note: 'X' })).toContain('{{note}}');
  });
});

describe('loadWorkflows', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'hive-wf-'));
    dirs.push(d);
    return d;
  };

  test('splits valid and invalid, ignores non-md and nested', async () => {
    const root = tmp();
    mkdirSync(join(root, 'workflow/sub'), { recursive: true });
    writeFileSync(join(root, 'workflow/a.md'), VALID);
    writeFileSync(join(root, 'workflow/b.md'), '---\nfoo: 1\n---\nx');
    writeFileSync(join(root, 'workflow/notes.txt'), 'hi');
    writeFileSync(join(root, 'workflow/sub/c.md'), VALID);
    const { valid, invalid } = await loadWorkflows(root);
    expect(valid.map((w) => w.name)).toEqual(['a']);
    expect(invalid).toEqual([{ name: 'b', error: expect.stringMatching(/description/) }]);
  });

  test('no workflow dir', async () => {
    expect(await loadWorkflows(tmp())).toEqual({ valid: [], invalid: [] });
  });
});

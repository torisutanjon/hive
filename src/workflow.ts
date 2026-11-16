import { parse } from 'yaml';
import { ContextError, listDir, readContext } from './context.ts';

export type WorkflowArg = { name: string; description?: string; required: boolean };
export type Workflow = { name: string; description: string; arguments: WorkflowArg[]; body: string };
export type Workflows = { valid: Workflow[]; invalid: { name: string; error: string }[] };

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const ARG = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function parseWorkflow(name: string, text: string): Workflow {
  if (!NAME.test(name)) throw new ContextError('workflow name must be lowercase letters, digits and dashes');
  const t = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(t);
  if (!m) throw new ContextError('missing frontmatter (--- ... ---)');
  let fm: unknown;
  try {
    fm = parse(m[1] as string);
  } catch {
    throw new ContextError('frontmatter is not valid YAML');
  }
  if (typeof fm !== 'object' || fm === null || Array.isArray(fm)) {
    throw new ContextError('description is required');
  }
  const f = fm as Record<string, unknown>;
  if (typeof f.description !== 'string' || !f.description.trim()) {
    throw new ContextError('description is required');
  }
  const raw = f.arguments ?? [];
  if (!Array.isArray(raw)) throw new ContextError('arguments must be a list');
  const seen = new Set<string>();
  const args: WorkflowArg[] = raw.map((a: unknown, i: number) => {
    const o = a as Record<string, unknown> | null;
    if (
      typeof o !== 'object' ||
      o === null ||
      Array.isArray(o) ||
      typeof o.name !== 'string' ||
      !ARG.test(o.name) ||
      (o.description !== undefined && typeof o.description !== 'string') ||
      (o.required !== undefined && typeof o.required !== 'boolean')
    ) {
      throw new ContextError(`arguments[${i}] is invalid`);
    }
    if (seen.has(o.name)) throw new ContextError(`duplicate argument ${o.name}`);
    seen.add(o.name);
    return {
      name: o.name,
      ...(o.description !== undefined && { description: o.description }),
      required: o.required === true,
    };
  });
  return { name, description: f.description, arguments: args, body: m[2] as string };
}

export async function loadWorkflows(root: string): Promise<Workflows> {
  const out: Workflows = { valid: [], invalid: [] };
  let entries;
  try {
    entries = await listDir(root, 'workflow');
  } catch (e) {
    if (e instanceof ContextError && e.message === 'not found') return out;
    throw e;
  }
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    try {
      out.valid.push(parseWorkflow(name, (await readContext(root, `workflow/${entry.name}`)).content));
    } catch (e) {
      if (e instanceof ContextError) out.invalid.push({ name, error: e.message });
      else throw e;
    }
  }
  return out;
}

export function render(wf: Workflow, args: Record<string, string | undefined>): string {
  for (const a of wf.arguments) {
    if (a.required && !args[a.name]) throw new ContextError(`missing required argument: ${a.name}`);
  }
  const declared = new Set(wf.arguments.map((a) => a.name));
  return wf.body.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g, (m, n: string) =>
    declared.has(n) ? (args[n] ?? '') : m,
  );
}

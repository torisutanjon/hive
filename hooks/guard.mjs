import { readFileSync, realpathSync } from 'node:fs';
import { argv, exit, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';

const EDIT_TOOLS = {
  claude: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash'],
  codex: ['Bash', 'apply_patch'],
};
const GIT_READ = ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files'];
const PLAIN = ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'echo'];

/** @param {string} seg @returns {boolean} */
function segmentReadOnly(seg) {
  const [a, b, ...rest] = seg.trim().split(/\s+/);
  const args = [b, ...rest].filter((x) => x !== undefined);
  if (a === 'git') {
    if (args.some((x) => x.startsWith('--output'))) return false;
    if (b === 'branch') return rest.every((x) => x.startsWith('-') && !/^-[a-zA-Z]*[dDmMcC]|^--(delete|move|copy)/.test(x));
    return GIT_READ.includes(b);
  }
  if (a === 'find') return !/(^|\s)-(delete|exec|execdir|ok|okdir|fprint\w*|fls)(\s|$)/.test(seg);
  if (a === 'rg') return !args.some((x) => x.startsWith('--pre'));
  if (PLAIN.includes(a)) return true;
  if (a === 'yarn') return ['test', 'lint', 'type-check'].includes(b);
  if (a === 'npm') return b === 'test';
  return a === 'node' && b === '--test';
}

/** @param {unknown} cmd @returns {boolean} */
export function readOnly(cmd) {
  if (typeof cmd !== 'string' || /[>`'"\\${}]|<\(/.test(cmd)) return false;
  const segs = cmd.split(/&&|\|\||;|\||&|\n/).filter((s) => s.trim() !== '');
  return segs.length > 0 && segs.every(segmentReadOnly);
}

/** @param {'claude'|'codex'} provider @param {string[]} hands @param {any} input @returns {'allow'|'deny'} */
export function decide(provider, hands, input) {
  const tool = input?.tool_name;
  const edits = EDIT_TOOLS[provider];
  if (!edits) return 'deny';
  if (!edits.includes(tool)) return 'allow';
  const caller = provider === 'claude' ? input.agent_type : input.model;
  if (typeof caller === 'string' && hands.includes(caller)) return 'allow';
  if (tool === 'Bash' && readOnly(input.tool_input?.command)) return 'allow';
  return 'deny';
}

if (argv[1] && realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    // unparseable: treat as an edit by an unknown caller
    input = { tool_name: 'Bash' };
  }
  const hands = (argv[3] ?? '').split(',');
  if (decide(/** @type {'claude'|'codex'} */ (argv[2]), hands, input) === 'deny') {
    stderr.write('Hive: the brain plans; dispatch edits to hands-careful or hands-mechanical\n');
    exit(2);
  }
}

/** One node of Chromium's accessibility tree (Accessibility.getFullAXTree), the parts the snapshot reads. */
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** Roles an agent acts on; each gets a ref it can pass to click, type, select and hover. */
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
]);
/** Shown even without a name, for the page's structure. */
const STRUCTURE = new Set(['heading', 'list', 'listitem', 'table', 'row', 'form', 'dialog', 'alertdialog', 'navigation', 'main', 'img']);
const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea']);
const PROPS = ['level', 'checked', 'pressed', 'expanded', 'selected', 'disabled', 'required', 'readonly'];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const quote = (s: string) => JSON.stringify(clip(s.replace(/\s+/g, ' ').trim(), 200));

export interface Snapshot {
  text: string;
  refs: Map<string, number>;
}

/**
 * The page as an indented outline of roles and names, the way an agent reads it cheaply: interactive elements carry
 * [ref=eN], text appears once, and wrappers without meaning are left out.
 */
export function renderSnapshot(nodes: AXNode[], maxChars = 30_000): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId || !byId.has(n.parentId));
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let size = 0;
  let cut = false;
  const push = (depth: number, line: string) => {
    if (cut) return;
    const l = `${'  '.repeat(depth)}- ${line}`;
    if (size + l.length > maxChars) {
      cut = true;
      return;
    }
    size += l.length + 1;
    lines.push(l);
  };
  const walk = (n: AXNode, depth: number, parentName: string) => {
    if (cut) return;
    const role = n.role?.value ?? '';
    const name = String(n.name?.value ?? '').trim();
    let shown = false;
    if (!n.ignored && !TRANSPARENT.has(role)) {
      if (role === 'StaticText') {
        if (name && !parentName.includes(name)) push(depth, `text: ${quote(name)}`);
      } else {
        const interactive = INTERACTIVE.has(role) && n.backendDOMNodeId !== undefined;
        if (interactive || name || STRUCTURE.has(role)) {
          const props: string[] = [];
          for (const p of n.properties ?? []) {
            if (!PROPS.includes(p.name)) continue;
            const v = p.value?.value;
            if (v === undefined || v === false || v === 'false') continue;
            props.push(v === true || v === 'true' ? p.name : `${p.name}=${String(v)}`);
          }
          const value = n.value?.value;
          if (value !== undefined && value !== '' && ['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton'].includes(role))
            props.push(`value=${quote(String(value))}`);
          if (interactive) {
            const ref = `e${refs.size + 1}`;
            refs.set(ref, n.backendDOMNodeId!);
            props.push(`ref=${ref}`);
          }
          push(depth, `${role}${name ? ` ${quote(name)}` : ''}${props.length ? ` [${props.join(', ')}]` : ''}`);
          shown = true;
        }
      }
    }
    for (const c of n.childIds ?? []) {
      const child = byId.get(c);
      if (child) walk(child, shown ? depth + 1 : depth, shown ? name : parentName);
    }
  };
  if (root) walk(root, 0, '');
  if (cut) lines.push(`… (the page is longer; use yaho browser text, or scroll and snapshot again)`);
  return { text: lines.join('\n') || '(the page is empty)', refs };
}

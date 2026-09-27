/**
 * Drives the compiled film view without a browser.
 *
 * The view ships as source, so the only way to assert what it renders and what
 * it sends is to compile it and run it. The compiler bundles the design-system
 * shim in and leaves `react` external, so the module is loaded with a stub
 * React whose `createElement` returns a plain tree and whose `useState` /
 * `useEffect` keep cells across renders — enough to render, click, type and
 * re-render, and nothing more. What the view sends is captured off
 * `window.aflow.act`, and what it asks to play off `window.aflow.media` —
 * together the whole author-facing surface.
 */
import vm from 'node:vm';
import { validateAndCompile } from '@aflow/ui-artifact-compiler';
import { FILM_VIEW_SOURCE } from '../appletFixtures/film.js';

const VIEW_HANDLE = '__filmView';
// Minified output is one line with no space before the specifier
// (`import R from"react";var …`), so neither pattern may anchor on lines.
const REACT_IMPORT = /import\s+([A-Za-z_$][\w$]*)\s+from\s*"react";?/g;
const TRAILING_EXPORT = /export\s*\{[^{}]*\};?\s*$/;

interface Element {
  type: unknown;
  props: Record<string, unknown>;
}

type Component = (props: Record<string, unknown>) => unknown;

function isElement(value: unknown): value is Element {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; props?: unknown };
  return 'type' in candidate && typeof candidate.props === 'object' && candidate.props !== null;
}

export interface ActCall {
  name: string;
  input: Record<string, unknown>;
  extras: Record<string, unknown> | undefined;
}

interface Clickable {
  label: string;
  click: () => void;
}

interface TextField {
  /** Placeholder or accessible label — whichever names the field on screen. */
  name: string;
  change: (value: string) => void;
}

/**
 * What a `<video>` looks like to the view. Playback is imperative in a browser —
 * an element starts because something called `play()` on it — so a harness that
 * modelled only the attributes would report a cut playing that never moved.
 */
interface MediaElement {
  played: number;
  paused: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  play: () => Promise<void>;
  pause: () => void;
}

interface Playing {
  src: string;
  /** The screen carries transport controls; a strip tile is a still. */
  controls: boolean;
  /** The element's own end-of-clip handler, so a test can finish a clip. */
  ended?: () => void;
  /** The element the view was handed, and what it did to it. */
  element?: MediaElement;
}

interface Collected {
  stills: string[];
  text: string[];
  clickables: Clickable[];
  fields: TextField[];
  /** Every <video> the render put on screen, in tree order. */
  playing: Playing[];
}

function empty(): Collected {
  return { stills: [], text: [], clickables: [], fields: [], playing: [] };
}

/**
 * The elements the view is handed, kept across renders and keyed by where they
 * sit rather than by what they show. React preserves the node at a tree
 * position when only `src` changes, so a harness that minted one element per
 * source would hand the view a fresh object per clip — and an effect keyed on
 * the element would re-run for free, hiding a view that never restarts
 * playback on the clip after the first.
 *
 * Changing the source runs the load algorithm, which leaves the element paused
 * at zero. That is the state the view has to notice.
 */
const elements = new Map<string, MediaElement & { src: string }>();

function mediaElementFor(slot: string, src: string): MediaElement {
  const held = elements.get(slot);
  if (held !== undefined) {
    if (held.src !== src) {
      held.src = src;
      held.paused = true;
      held.currentTime = 0;
    }
    return held;
  }
  const element: MediaElement & { src: string } = {
    src,
    played: 0,
    paused: true,
    currentTime: 0,
    duration: Number.POSITIVE_INFINITY,
    playbackRate: 1,
    play() {
      element.played += 1;
      element.paused = false;
      return Promise.resolve();
    },
    pause() {
      element.paused = true;
    },
  };
  elements.set(slot, element);
  return element;
}

function collect(node: unknown, out: Collected): void {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string') {
    if (node.length > 0) out.text.push(node);
    return;
  }
  if (typeof node === 'number') {
    out.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return;
  }
  if (!isElement(node)) return;

  // A design-system component is a plain function of its props — calling it is
  // how the tree resolves down to host elements. Only the view itself uses
  // hooks, and it is called once per render pass, so the cell cursor is safe.
  if (typeof node.type === 'function') {
    collect((node.type as Component)(node.props), out);
    return;
  }

  const { props } = node;
  if (node.type === 'video' && typeof props['src'] === 'string') {
    const element = mediaElementFor(
      props['controls'] === true ? 'screen' : `strip:${props['src']}`,
      props['src'],
    );
    const attach = props['ref'];
    if (typeof attach === 'function') (attach as (node: MediaElement) => void)(element);
    const loaded = props['onLoadedMetadata'];
    if (typeof loaded === 'function') {
      (loaded as (event: { target: MediaElement }) => void)({ target: element });
    }
    out.playing.push({
      src: props['src'],
      controls: props['controls'] === true,
      element,
      ...(typeof props['onEnded'] === 'function' ? { ended: props['onEnded'] as () => void } : {}),
    });
  }
  if (node.type === 'img' && typeof props['src'] === 'string') out.stills.push(props['src']);
  const onClick = props['onClick'];
  if (typeof onClick === 'function' && props['disabled'] !== true) {
    const label = empty();
    collect(props['children'], label);
    out.clickables.push({ label: label.text.join('').trim(), click: onClick as () => void });
  }
  const onChange = props['onChange'];
  const placeholder = props['placeholder'];
  const ariaLabel = props['aria-label'];
  const fieldName =
    typeof placeholder === 'string'
      ? placeholder
      : typeof ariaLabel === 'string'
        ? ariaLabel
        : null;
  if (typeof onChange === 'function' && fieldName !== null) {
    const change = onChange as (event: { target: { value: string } }) => void;
    out.fields.push({ name: fieldName, change: (value) => change({ target: { value } }) });
  }
  collect(props['children'], out);
}

export interface MountedView {
  /** Everything the current render puts on screen, as one string. */
  text: () => string;
  /** Clicks the `occurrence`-th enabled control whose label contains `label`. */
  click: (label: string, occurrence?: number) => void;
  /** Types into the first field whose placeholder or label contains `fragment`. */
  fill: (fragment: string, value: string) => void;
  /** Every command the view has sent, in order. */
  calls: ActCall[];
  labels: () => string[];
  /** The `src` of every <video> on screen — what the room can actually watch. */
  playing: () => string[];
  /** What the big frame is playing, or null when it is showing words instead. */
  screen: () => string | null;
  /** Every asset the view has asked the host to serve, in order. */
  asked: AssetPin[];
  /** Lets the act promises settle, then re-renders what they changed. */
  settle: () => Promise<void>;
  /** The `src` of the still on the big frame, or null when a clip is playing. */
  still: () => string | null;
  /** How many times the view has started the clip on the screen. */
  started: () => number;
  /** Fires the screen clip's own end-of-clip handler. */
  endClip: () => void;
  /** Moves the view's clock, firing whatever came due, then re-renders. */
  tick: (ms: number) => void;
}

/** What the stub host answers with — 'applied' unless a test asks otherwise. */
export interface ActResult {
  status: string;
  validation?: string[];
  currentVersion?: number;
}

export interface AssetPin {
  path: string;
  version: number;
  contentHash: string;
}

export type MediaAnswer =
  { status: 'ready'; url: string } | { status: 'refused'; reason?: string; message: string };

/** The stub media channel — every pinned asset is servable unless a test says otherwise. */
export type MediaHost = (asset: AssetPin) => MediaAnswer;

const SERVE_EVERYTHING: MediaHost = (asset) => ({ status: 'ready', url: `blob:${asset.path}` });

export interface MountOptions {
  answer?: ActResult;
  media?: MediaHost;
}

let compiled: string | null = null;

async function compiledView(): Promise<string> {
  if (compiled !== null) return compiled;
  // The handle is a test affordance; the compile gate asserts the unmodified
  // source, so nothing here can hide a defect in what actually ships.
  const result = await validateAndCompile(
    `${FILM_VIEW_SOURCE}\nglobalThis.${VIEW_HANDLE} = FilmView;\n`,
    'react_tsx',
    [],
    [],
  );
  if (!result.valid || result.compiledCode === undefined) {
    throw new Error(
      `the film view did not compile: ${result.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`,
    );
  }
  // Held in a local first: the cache is nullable, so returning it back would
  // widen what this promises to return.
  const code = result.compiledCode;
  compiled = code;
  return code;
}

export async function mountFilmView(
  props: Record<string, unknown>,
  options: MountOptions = {},
): Promise<MountedView> {
  const answer = options.answer ?? { status: 'applied' };
  const serve = options.media ?? SERVE_EVERYTHING;
  const code = await compiledView();

  const reactLocals: string[] = [];
  for (const match of code.matchAll(REACT_IMPORT)) {
    const local = match[1];
    if (local !== undefined) reactLocals.push(local);
  }
  if (reactLocals.length === 0) throw new Error('the compiled view imports no react binding');

  const script = code.replace(REACT_IMPORT, '').replace(TRAILING_EXPORT, '');

  const cells: unknown[] = [];
  const cleanups = new Map<number, () => void>();
  let cursor = 0;
  let pendingEffects: Array<{ index: number; effect: () => unknown }> = [];
  const react = {
    createElement(type: unknown, elementProps: unknown, ...children: unknown[]): Element {
      const base =
        typeof elementProps === 'object' && elementProps !== null
          ? (elementProps as Record<string, unknown>)
          : {};
      return { type, props: { ...base, ...(children.length > 0 ? { children } : {}) } };
    },
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const index = cursor;
      cursor += 1;
      if (cells.length <= index) {
        cells[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      }
      const set = (next: unknown): void => {
        cells[index] =
          typeof next === 'function' ? (next as (prev: unknown) => unknown)(cells[index]) : next;
      };
      return [cells[index], set];
    },
    // Deps are compared and the callback queued, never run inline: an effect
    // that setStates during the render pass it was declared in would rewrite
    // the tree the caller is about to read.
    useEffect(effect: () => unknown, deps?: unknown[]): void {
      const index = cursor;
      cursor += 1;
      const previous = cells[index] as unknown[] | undefined;
      const changed =
        deps === undefined ||
        previous === undefined ||
        previous.length !== deps.length ||
        deps.some((value, at) => !Object.is(value, previous[at]));
      cells[index] = deps ?? [];
      if (changed) pendingEffects.push({ index, effect });
    },
  };

  elements.clear();
  const calls: ActCall[] = [];
  const asked: AssetPin[] = [];
  // The view holds a still for a shot's own length, so its clock is part of
  // what a sequence does. A real timer would make every playback test a race;
  // this one only moves when a test says so.
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fire: () => void }>();
  const context: Record<string, unknown> = {
    crypto,
    setTimeout(fire: () => void, ms: unknown): number {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + (typeof ms === 'number' ? ms : 0), fire });
      return id;
    },
    clearTimeout(id: unknown): void {
      if (typeof id === 'number') timers.delete(id);
    },
    window: {
      aflow: {
        act(name: string, input: Record<string, unknown>, extras?: Record<string, unknown>) {
          calls.push({ name, input, extras });
          return Promise.resolve(answer);
        },
        media(asset: AssetPin) {
          asked.push(asset);
          return Promise.resolve(serve(asset));
        },
      },
    },
  };
  for (const local of reactLocals) context[local] = react;

  vm.createContext(context);
  vm.runInContext(`${script}\nglobalThis.${VIEW_HANDLE} = ${VIEW_HANDLE};`, context);

  const component = context[VIEW_HANDLE];
  if (typeof component !== 'function') throw new Error('the compiled view exposed no component');

  let tree: Collected = empty();
  const render = (): void => {
    cursor = 0;
    pendingEffects = [];
    tree = empty();
    collect((component as Component)(props), tree);
    const queued = pendingEffects;
    pendingEffects = [];
    for (const { index, effect } of queued) {
      // React tears the last run down before starting the next. A harness that
      // skipped this would never exercise a clearTimeout, so a timer surviving
      // a state change would pass here and fire in a browser.
      cleanups.get(index)?.();
      cleanups.delete(index);
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.set(index, cleanup as () => void);
    }
  };
  render();

  return {
    // JSX already carries the spacing between its own children, so joining
    // with anything would double it.
    text: () => tree.text.join(''),
    labels: () => tree.clickables.map((entry) => entry.label),
    playing: () => tree.playing.map((entry) => entry.src),
    screen: () => tree.playing.find((entry) => entry.controls)?.src ?? null,
    still: () => tree.stills[0] ?? null,
    started: () => tree.playing.find((entry) => entry.controls)?.element?.played ?? 0,
    endClip() {
      const screen = tree.playing.find((entry) => entry.controls);
      if (screen?.ended === undefined) {
        throw new Error('nothing on the screen is playing a clip that could end');
      }
      screen.ended();
      render();
    },
    tick(ms) {
      now += ms;
      // A fired timer sets state, the re-render arms the next one, and that one
      // may already be due at this instant. Draining in one pass would report a
      // sequence stalled that a browser would have carried through.
      for (let pass = 0; pass < 100; pass += 1) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (next === undefined) break;
        timers.delete(next[0]);
        next[1].fire();
        render();
      }
    },
    calls,
    asked,
    async settle() {
      // A macrotask boundary drains the whole microtask queue, so a chained
      // sequence of acts has finished by the time this returns.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      render();
    },
    click(label, occurrence = 0) {
      const matches = tree.clickables.filter((entry) => entry.label.includes(label));
      const target = matches[occurrence];
      if (target === undefined) {
        throw new Error(
          `no enabled control #${occurrence} labelled '${label}' (${matches.length} matched) — on screen: ${tree.clickables
            .map((entry) => entry.label)
            .join(' | ')}`,
        );
      }
      target.click();
      render();
    },
    fill(fragment, value) {
      const target = tree.fields.find((entry) => entry.name.includes(fragment));
      if (target === undefined) {
        throw new Error(
          `no field named '${fragment}' — on screen: ${tree.fields
            .map((entry) => entry.name)
            .join(' | ')}`,
        );
      }
      target.change(value);
      render();
    },
  };
}

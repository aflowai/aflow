/**
 * The readings the film view renders from — the pure half of the view source.
 *
 * Separated from the component because the two change for different reasons: a
 * reading moves when what the document means changes, the component when what
 * the room can do with it does. They compile as one module; only the file is
 * split, because together they outgrow the file-size bound.
 */
export const FILM_VIEW_READINGS = `
import React from 'react';
import {
  Badge,
  Button,
  Card,
  Column,
  EmptyState,
  FilterChips,
  Heading,
  Input,
  Panel,
  Row,
  ScrollArea,
  Text,
} from '@aflow/design-system';

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ROLE_PATTERN = /^[a-z][a-z0-9_]{1,23}$/;

const PROMPT_MAX = 1200;
const NEGATIVE_PROMPT_MAX = 600;
const LOOK_MAX = 300;
const GRADE_NOTE_MAX = 600;
const COMMENT_MAX = 600;
const DURATION_MAX = 30;
const SPEED_MAX = 4;

/** The strip reads as a timeline, so a tile is as wide as its shot is long. */
const TILE_PIXELS_PER_SECOND = 26;
const TILE_MIN_WIDTH = 76;

const AREA_STYLE = {
  width: '100%',
  minHeight: '72px',
  padding: '6px 12px',
  border: '1px solid var(--ds-border-default)',
  borderRadius: '8px',
  fontSize: '14px',
  fontFamily: 'inherit',
  lineHeight: 1.5,
  color: 'var(--ds-text-primary)',
  background: 'var(--ds-bg-panel)',
  outline: 'none',
  resize: 'vertical',
};

const SCREEN_STYLE = {
  width: '100%',
  background: '#000',
  borderRadius: '8px',
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
};

const FILL_STYLE = { width: '100%', height: '100%', objectFit: 'contain', display: 'block' };

const STRIP_STYLE = { display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '6px' };

const FRAME_STYLE = {
  height: '64px',
  borderRadius: '6px',
  overflow: 'hidden',
  background: '#000',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

function mintId(prefix, length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return prefix + out;
}

function seconds(rationalTime) {
  if (!rationalTime || !rationalTime.rate) return 0;
  return rationalTime.value / rationalTime.rate;
}

function frameCount(secondsValue, rate) {
  return Math.max(0, Math.round(secondsValue * rate));
}

function timecode(totalSeconds) {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  const whole = Math.floor(rest);
  const tenths = Math.floor((rest - whole) * 10);
  return minutes + ':' + String(whole).padStart(2, '0') + '.' + tenths;
}

function round(value, places) {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

function listOf(parts) {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/** A typed field reads back as text, and '' coerces to 0 — so parse, never cast. */
function numberField(value) {
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '' || text === null || text === undefined) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function same(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => same(a[key], b[key]));
}

/** The identity the host serves an asset by — path, version and the bytes both. */
function assetKey(asset) {
  return asset.path + '@' + asset.version + '#' + asset.contentHash;
}

function fileName(pin) {
  if (!pin || !pin.path) return 'unpinned';
  const parts = pin.path.split('/');
  return parts[parts.length - 1] || pin.path;
}

function tileWidth(playSeconds) {
  return Math.max(TILE_MIN_WIDTH, Math.round(playSeconds * TILE_PIXELS_PER_SECOND)) + 'px';
}

/**
 * What the shot asks for now, minus what its selected take was answered from.
 * An axis the view can rewrite carries the action that would restore it; route
 * and conditioning carry none, because only a re-render settles those.
 *
 * A label is a whole clause, because the sentence that reads them out puts
 * 'since it was rendered' in front of the list rather than after it.
 */
function driftAxes(shot, gradePlate) {
  const was = shot.selectedTake && shot.selectedTake.renderedFrom;
  if (!was) return [];
  const axes = [];
  // A regrade moves neither the shot nor its frame, so nothing below would
  // notice: the take goes on matching a shot whose keyframe answers a look the
  // film has left behind, and the cut reads settled while it has drifted.
  //
  // Bindings are deliberately not part of this. A rebound role already carries
  // its own restorable axis, and rebinding it back settles the frame too — so
  // counting it here would withdraw a restore that does work.
  if (animatesAFrame(shot) && !keyframeAnswersTheFilm(shot, gradePlate)) {
    axes.push({ label: 'the frame it animates no longer answers the film', restore: null });
  }
  if (shot.prompt !== was.prompt) {
    axes.push({ label: 'the prompt changed', restore: 'prompt' });
  }
  if (shot.negativePrompt !== was.negativePrompt) {
    axes.push({ label: 'the negative prompt changed', restore: 'prompt' });
  }
  if (shot.screenDirection !== was.screenDirection) {
    axes.push({ label: 'the direction of travel changed', restore: 'prompt' });
  }
  if (shot.durationSeconds !== was.durationSeconds) {
    // A re-render settles this one: the clip in hand is the old length, and
    // nothing about playing it shorter makes it the length the shot asks for.
    axes.push({ label: 'the length changed', restore: null });
  }
  if (!same(shot.route, was.route)) {
    axes.push({ label: 'the route changed', restore: null });
  }
  if (!same(shot.conditioning, was.conditioning)) {
    axes.push({ label: 'the conditioning changed', restore: null });
  }
  if (!same((shot.keyframe || {}).asset, was.keyframe)) {
    axes.push({ label: 'the frame it animates was re-rendered', restore: null });
  }
  const now = shot.entities || {};
  const then = was.entities || {};
  Object.keys(Object.assign({}, now, then))
    .sort()
    .forEach((role) => {
      if (same(now[role], then[role])) return;
      const label =
        then[role] === undefined
          ? role + ' was bound'
          : now[role] === undefined
            ? role + ' was dropped'
            : role + ' was rebound';
      axes.push({ label, restore: 'role', role, entity: then[role] });
    });
  return axes;
}

/**
 * The calls that put the shot back where its take was rendered from. The
 * closing select_take passes only because the steps before it made the
 * provenance match again — it is the journal entry for a shot settled without
 * spending a generation.
 */
function restoreSteps(shotId, shot, axes) {
  const was = shot.selectedTake.renderedFrom;
  const steps = [];
  if (axes.some((axis) => axis.restore === 'prompt')) {
    steps.push({
      name: 'set_prompt',
      input: {
        shotId,
        prompt: was.prompt,
        negativePrompt: was.negativePrompt,
        screenDirection: was.screenDirection,
      },
    });
  }
  axes.forEach((axis) => {
    if (axis.restore !== 'role') return;
    if (axis.entity === undefined) {
      steps.push({ name: 'unbind_shot_entity', input: { shotId, role: axis.role } });
    } else {
      steps.push({
        name: 'bind_shot_entity',
        input: { shotId, role: axis.role, entity: axis.entity },
      });
    }
  });
  steps.push({
    name: 'select_take',
    input: { shotId, take: shot.selectedTake },
    outcome:
      'shot restored to take ' + shot.selectedTake.takeId + ' — settled without a re-render',
  });
  return steps;
}

/**
 * One track in timeline order. An item starts where the previous one ended, so
 * the running cursor is the film's own clock; a clip occupies its source range
 * divided by the speed applied at assembly.
 */
function readTrack(track, shots, gradePlate) {
  const items = Array.isArray(track && track.items) ? track.items : [];
  const entries = [];
  let cursor = 0;
  let clips = 0;
  items.forEach((item, itemIndex) => {
    if (!item) return;
    if (item.kind === 'clip') {
      const shot = shots[item.shotId] || {};
      const speed = typeof shot.speed === 'number' && shot.speed > 0 ? shot.speed : 1;
      const sourceSeconds = seconds(item.sourceRange && item.sourceRange.duration);
      const playSeconds = sourceSeconds / speed;
      clips += 1;
      entries.push({
        kind: 'clip',
        clip: item,
        itemIndex,
        position: clips,
        shotId: item.shotId,
        shot,
        speed,
        sourceSeconds,
        playSeconds,
        startSeconds: cursor,
        drift: driftAxes(shot, gradePlate),
      });
      cursor += playSeconds;
      return;
    }
    if (item.kind === 'gap') {
      const holdSeconds = seconds(item.duration);
      entries.push({
        kind: 'gap',
        item,
        itemIndex,
        playSeconds: holdSeconds,
        startSeconds: cursor,
      });
      cursor += holdSeconds;
      return;
    }
    if (item.kind === 'audio') {
      const playSeconds = seconds(item.sourceRange && item.sourceRange.duration);
      entries.push({ kind: 'audio', item, itemIndex, playSeconds, startSeconds: cursor });
      cursor += playSeconds;
      return;
    }
    if (item.kind === 'transition') {
      // A transition overlaps the cut it sits on rather than occupying the
      // track, so it takes no time off the clock.
      entries.push({ kind: 'transition', item, itemIndex, playSeconds: 0, startSeconds: cursor });
    }
  });
  return { entries, runtime: cursor };
}

/**
 * The whole document, read in order: the main video track, whose clips are the
 * strip, and every other track that carries something.
 */
/**
 * Every set entity a shot stands in, identified by its pinned bytes — a name
 * is a label the room can change, and two different sets can share one. The
 * same set bound into two roles is one place; distinct pins behind one name
 * are two. The names ride along only to be read out.
 */
function placeOf(shot) {
  const entities = shot.entities || {};
  const byIdentity = {};
  Object.keys(entities)
    .sort()
    .forEach((role) => {
      const binding = entities[role];
      if (!binding || binding.kind !== 'set') return;
      const key = (binding.pins || []).map(assetKey).sort().join('+');
      if (!key || byIdentity[key]) return;
      byIdentity[key] = binding.name || role;
    });
  const keys = Object.keys(byIdentity).sort();
  if (keys.length === 0) return null;
  return { key: keys.join(' '), label: keys.map((key) => byIdentity[key]).join(' and ') };
}

/**
 * The bindings a render will not see: a shot conditioning on the prompt alone
 * passes nothing to the route, so every entity it binds stays out of the
 * frame — billed in full and missing the person. Nothing refuses this, by
 * design; a surface that stays quiet about it reads an authored shot as a
 * ready one.
 */
function blindBindings(shot) {
  const conditioning = shot.conditioning || {};
  if (conditioning.mode !== 'prompt') return [];
  const entities = shot.entities || {};
  return Object.keys(entities)
    .map((role) => (entities[role] || {}).name || role)
    .sort();
}

const OPPOSED = {
  left_to_right: 'right_to_left',
  right_to_left: 'left_to_right',
  toward: 'away',
  away: 'toward',
};

/**
 * What adjacent cuts inside one scene claim and break — derived on every read,
 * never stored, the standing the staleness comparison has. A scene is
 * continuous time in one place, so a cut inside it implies nothing moved:
 * opposed directions read as the subject turning around, and different set
 * entities read as a teleport. Warnings, never refusals — sometimes the flip
 * is the shot.
 */
function continuityNotes(rows, shots) {
  const notes = [];
  for (let at = 1; at < rows.length; at += 1) {
    const before = rows[at - 1];
    const after = rows[at];
    const scene = shots[after.shotId] && shots[after.shotId].sceneId;
    if (!scene || !shots[before.shotId] || shots[before.shotId].sceneId !== scene) continue;

    const directionBefore = shots[before.shotId].screenDirection;
    const directionAfter = shots[after.shotId].screenDirection;
    if (directionBefore && OPPOSED[directionBefore] === directionAfter) {
      notes.push({
        kind: 'direction_flip',
        at,
        beforeShotId: before.shotId,
        afterShotId: after.shotId,
        text:
          (shots[after.shotId].name || after.shotId) +
          ' reverses the direction of travel against ' +
          (shots[before.shotId].name || before.shotId) +
          ' inside one scene — the subject reads as turning around',
      });
    }

    const placeBefore = placeOf(shots[before.shotId]);
    const placeAfter = placeOf(shots[after.shotId]);
    if (placeBefore !== null && placeAfter !== null && placeBefore.key !== placeAfter.key) {
      notes.push({
        kind: 'location_jump',
        at,
        beforeShotId: before.shotId,
        afterShotId: after.shotId,
        text:
          (shots[after.shotId].name || after.shotId) +
          ' stands in ' +
          placeAfter.label +
          ' while ' +
          (shots[before.shotId].name || before.shotId) +
          ' stands in ' +
          placeBefore.label +
          ' — one scene, two places',
      });
    }
  }
  return notes;
}

function readCut(state) {
  const gradePlate = (state.grade || {}).plate;
  const tracks = (state.timeline && state.timeline.tracks) || [];
  let trackIndex = tracks.findIndex((track) => track && track.kind === 'video');
  if (trackIndex < 0) trackIndex = 0;
  const shots = state.shots || {};
  const video = readTrack(tracks[trackIndex], shots, gradePlate);
  const under = [];
  tracks.forEach((track, index) => {
    if (index === trackIndex || !track) return;
    const read = readTrack(track, shots, gradePlate);
    if (read.entries.length === 0) return;
    under.push({ name: track.name || track.kind, entries: read.entries });
  });
  return {
    rows: video.entries.filter((entry) => entry.kind === 'clip'),
    entries: video.entries,
    under,
    trackIndex,
    runtime: video.runtime,
  };
}

function takeState(row) {
  if (!row.shot.selectedTake) return 'waiting';
  return row.drift.length > 0 ? 'stale' : 'settled';
}

/**
 * A shot with no take is waiting on a generation — unless the document already
 * says the generation cannot answer it, which is what a shot conditioning on
 * its bindings with nothing bound is.
 */
/**
 * What a binding is pinned to, in one phrase. An identity is several angles at
 * one version, so the count is what a reader needs and the version is what
 * tells two bindings of the same character apart.
 */
function pinSummary(binding) {
  const pins = (binding && binding.pins) || [];
  const first = pins[0];
  if (!first) return '';
  return pins.length > 1 ? 'v' + first.version + ' · ' + pins.length + ' angles' : 'v' + first.version;
}

/** Only these two animate a frame; the others never own a keyframe at all. */
function animatesAFrame(shot) {
  const mode = (shot.conditioning || {}).mode;
  return mode === 'reference' || mode === 'frames';
}

/**
 * Whether the frame answers the recipe the shot asks for now, and the look the
 * film has now. Kept apart from the bindings because only these two are beyond
 * a restore: rebinding a role back settles the frame, editing the film's grade
 * back is not something a shot can do.
 *
 * The film's current plate is compared as well as the recipe's, because a
 * regrade moves neither the recipe nor the frame: the two go on agreeing with
 * each other while both name a look the film has left behind.
 */
function keyframeAnswersTheFilm(shot, gradePlate) {
  const keyframe = shot.keyframe || {};
  const recipe = shot.keyframeRecipe;
  if (!keyframe.asset || !recipe) return false;
  const was = keyframe.renderedFrom || {};
  return same(was.recipe, recipe) && same((was.recipe || {}).gradePlate, gradePlate);
}

/**
 * Whether the frame a shot holds still answers the shot as it now stands. A
 * keyframe carries what its own render read, so this is the same comparison a
 * take answers to — and the reason an edited recipe leaves the frame in place
 * rather than discarding it.
 */
function keyframeIsCurrent(shot, gradePlate) {
  const was = (shot.keyframe || {}).renderedFrom || {};
  return (
    keyframeAnswersTheFilm(shot, gradePlate) &&
    same(was.entities || {}, shot.entities || {}) &&
    was.screenDirection === shot.screenDirection
  );
}

function waitingFor(shot, gradePlate) {
  const conditioning = shot.conditioning || {};
  if (conditioning.mode === 'reference' && Object.keys(shot.entities || {}).length === 0) {
    return 'waiting on a reference to condition on';
  }
  // Reading the frame before the take is what the order of work is: a shot
  // animating nothing cannot be animated, so 'waiting on a take' would name
  // the second render while the first is the one outstanding.
  if (animatesAFrame(shot)) {
    if (!shot.keyframeRecipe) {
      return 'waiting on a keyframe recipe — it animates a frame and has no way to make one';
    }
    if (!keyframeIsCurrent(shot, gradePlate)) {
      return (shot.keyframe || {}).asset
        ? 'waiting on a new keyframe — the frame it holds answers an older recipe'
        : 'waiting on its keyframe — the frame it animates has not been rendered';
    }
  }
  return 'waiting on its first take';
}
`;

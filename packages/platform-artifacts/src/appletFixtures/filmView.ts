/**
 * The film view — a screen, a strip of shots and the buttons that edit what is
 * on them. It renders the document the agent reasons over and drives every
 * mutation through the declared actions, so the view never writes state.
 *
 * Where a shot stands is computed on every render: a shot with no selected
 * take is waiting on one, and a take whose renderedFrom differs from the shot
 * it sits on is stale. Neither is a field, so neither can be left behind by
 * the thing it describes.
 *
 * A clip reaches the frame through the host's media channel, which serves only
 * the assets this instance's own state pins. The view asks for the shot in
 * hand and the two either side of it — the ones one click or one cut away — so
 * a forty-five shot cut never puts forty-five clips in flight.
 */
import { FILM_VIEW_READINGS } from './filmViewReadings.js';

export const FILM_VIEW_SOURCE =
  FILM_VIEW_READINGS +
  `
export default function FilmView({ state: liveState, viewer: liveViewer, seats: liveSeats }) {
  const state = liveState || {};
  const viewer = liveViewer || {};
  const project = state.project || {};
  const grade = state.grade || {};
  const shots = state.shots || {};
  const entities = state.entities || {};
  const casting = state.casting || {};
  const markers = state.markers || {};
  const seats = Array.isArray(liveSeats) ? liveSeats : [];

  const readOnly = viewer.spaceRole === 'viewer';
  const appletRoles = Array.isArray(viewer.appletRoles) ? viewer.appletRoles : [];
  const directorElsewhere = appletRoles.length > 0 && appletRoles.indexOf('director') < 0;

  const cut = readCut(state);
  const rows = cut.rows;
  const entityKeys = Object.keys(entities).sort();
  // A review pass reads notes against the cut, so they are listed the way they
  // are watched. A minted id sorts at random.
  const openNotes = Object.keys(markers).sort((a, b) => {
    const byTime = seconds(markers[a].at) - seconds(markers[b].at);
    if (byTime !== 0) return byTime;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const notesOn = (shotId) => openNotes.filter((id) => markers[id].shotId === shotId);
  const waiting = rows.filter((row) => takeState(row) === 'waiting').length;
  const continuity = continuityNotes(rows, shots);
  const stale = rows.filter((row) => takeState(row) === 'stale').length;
  const blind = rows.filter((row) => blindBindings(row.shot).length > 0).length;
  const ratio = (project.aspectRatio || '16:9').replace(':', ' / ');

  const [heldShot, setHeldShot] = React.useState(null);
  const [clips, setClips] = React.useState({});
  const [notice, setNotice] = React.useState(null);
  const [editor, setEditor] = React.useState(null);
  const [confirming, setConfirming] = React.useState(null);
  const [inFlight, setInFlight] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [holding, setHolding] = React.useState(null);
  const busy = inFlight > 0;

  let index = rows.findIndex((row) => row.shotId === heldShot);
  if (index < 0) index = 0;
  const current = rows[index] || null;

  const show = (asset) => {
    const bridge = typeof window !== 'undefined' ? window.aflow : undefined;
    return bridge && typeof bridge.media === 'function'
      ? bridge.media(asset)
      : Promise.resolve({ status: 'refused', message: 'This surface cannot play clips.' });
  };

  // The shot in hand and the two either side — the ones a click or a cut away.
  // A shot with no take contributes its keyframe instead, because that is what
  // the sequence holds in its place and what the next render is bought from.
  const reachable = [];
  [index - 1, index, index + 1].forEach((at) => {
    const row = rows[at];
    if (!row) return;
    if (row.shot.selectedTake) reachable.push(row.shot.selectedTake.asset);
    else if ((row.shot.keyframe || {}).asset) reachable.push(row.shot.keyframe.asset);
  });
  // The world is on the board too: the grade plate and each library entity's
  // first pin. Stills, fetched eagerly — the plates are what the room judges
  // before any shot exists, which is when the world is cheapest to change.
  if (grade.plate) reachable.push(grade.plate);
  entityKeys.forEach((key) => {
    const pins = (entities[key] || {}).pins || [];
    if (pins[0]) reachable.push(pins[0]);
  });
  const reachableKeys = reachable.map(assetKey).join(' ');

  React.useEffect(() => {
    // The host holds the bytes it has already granted and answers a repeat from
    // its own map, so asking for the whole run costs one round trip per clip
    // rather than a ledger the view would have to keep in step with eviction.
    reachable.forEach((asset) => {
      show(asset).then((shown) => {
        setClips((held) => ({ ...held, [assetKey(asset)]: shown }));
      });
    });
  }, [reachableKeys]);

  const report = (result) => {
    if (!result) return true;
    if (result.status === 'applied') {
      setNotice(null);
      return true;
    }
    if (result.status === 'conflict') {
      setNotice({
        tone: 'warning',
        text: 'The cut moved while you were editing, so the change was not applied. Read the fresh cut and act again.',
      });
      return false;
    }
    // A guard rejection and a failed test op carry their reason on \`message\`;
    // only an input-schema violation fills \`validation\`. Reading one and not the
    // other turns the two refusals a real editing session hits most into silence.
    const said =
      typeof result.message === 'string' && result.message.length > 0
        ? result.message
        : Array.isArray(result.validation) && result.validation.length > 0
          ? result.validation.join(' · ')
          : 'The platform refused the change and gave no detail.';
    setNotice({ tone: 'danger', text: said });
    return false;
  };

  const send = (name, input, extras) => {
    setInFlight((count) => count + 1);
    const bridge = typeof window !== 'undefined' ? window.aflow : undefined;
    const sent =
      bridge && typeof bridge.act === 'function'
        ? bridge.act(name, input, extras)
        : Promise.reject(new Error('aflow host bridge unavailable'));
    return sent
      .then(report, (err) => {
        setNotice({
          tone: 'danger',
          text:
            'The change could not be sent: ' +
            (err && err.message ? err.message : 'the host did not answer.'),
        });
        return false;
      })
      .then((ok) => {
        setInFlight((count) => count - 1);
        return ok;
      });
  };

  /**
   * A sequence of acts reads as one change, so the count is held for the whole
   * chain rather than falling to zero between its steps.
   */
  const runSteps = (steps) => {
    setInFlight((count) => count + 1);
    let chain = Promise.resolve(true);
    steps.forEach((step) => {
      chain = chain.then((ok) =>
        ok
          ? send(step.name, step.input, step.outcome ? { outcome: step.outcome } : undefined)
          : false,
      );
    });
    return chain.then((ok) => {
      setInFlight((count) => count - 1);
      return ok;
    });
  };

  const openEditor = (kind, draft) => {
    setConfirming(null);
    setEditor({ kind, draft });
  };
  const isOpen = (kind) => editor !== null && editor.kind === kind;
  const draftOf = () => (editor ? editor.draft : {});
  const patchDraft = (next) =>
    setEditor((open) => (open ? { ...open, draft: { ...open.draft, ...next } } : open));
  const closeEditor = () => setEditor(null);
  const toggleEditor = (kind, draft) => {
    if (isOpen(kind)) closeEditor();
    else openEditor(kind, draft);
  };
  const commit = (promise) => {
    promise.then((ok) => {
      if (ok) closeEditor();
    });
  };

  /** Taking a different shot in hand drops a draft written against the last one. */
  const hold = (shotId) => {
    setEditor(null);
    setConfirming(null);
    setHeldShot(shotId);
  };

  // ── Watching the cut ──

  /**
   * What follows the clip at its position on the track, and what the screen holds
   * on the way there. A gap takes time off the clock, so playing straight from
   * one clip to the next would report a cut the film does not have.
   */
  const afterClip = (position) => {
    const at = cut.entries.findIndex(
      (entry) => entry.kind === 'clip' && entry.position === position,
    );
    if (at < 0) return { kind: 'end', black: 0 };
    let black = 0;
    for (let step = at + 1; step < cut.entries.length; step += 1) {
      const entry = cut.entries[step];
      if (entry.kind === 'clip') return { kind: 'clip', shotId: entry.shotId, black };
      // Anything else on this track still took time off the film's clock when
      // the cut was read, so skipping it would play a cut shorter than the one
      // every timecode on screen describes.
      black += entry.playSeconds || 0;
    }
    return { kind: 'end', black };
  };

  const stopPlaying = () => {
    setPlaying(false);
    setHolding(null);
  };

  const advance = () => {
    if (!current) return stopPlaying();
    const next = afterClip(current.position);
    // Black after the last clip is still part of the film's runtime, so ending
    // on the final frame would play a cut shorter than the one the header says.
    if (next.black > 0) {
      setHolding({ until: next.kind === 'clip' ? next.shotId : null, seconds: next.black });
      return;
    }
    if (next.kind === 'end') return stopPlaying();
    setHeldShot(next.shotId);
  };

  /** The clip on screen, when the host has actually served its bytes. */
  const readyClip = (row) => {
    const take = row && row.shot.selectedTake;
    if (!take) return null;
    const shown = clips[assetKey(take.asset)];
    return shown && shown.status === 'ready' ? shown : null;
  };

  /**
   * How long the sequence holds this shot itself. A playable clip ends through
   * its own element and needs no clock; everything else — a shot with no take,
   * a take the host would not serve, a take still arriving — is held for the
   * length the shot occupies in the cut, which is what keeps a missing or
   * refused clip from stopping the sequence dead.
   */
  const holdSecondsFor = (row) => {
    if (!row || readyClip(row) || row.playSeconds <= 0) return 0;
    return row.playSeconds;
  };

  /**
   * Starting the cut pins the shot it starts from. Left unpinned, a removal by
   * another seat is undetectable — the pointer was already null, so the fallback
   * to the first row reads as an ordinary move and the film replays from the top.
   */
  const startPlaying = () => {
    if (heldShot === null && current) setHeldShot(current.shotId);
    setPlaying(true);
  };

  // The element is imperative: a clip plays because something called play() on
  // it. Flipping the autoplay attribute on an element that is already loaded
  // and paused does nothing at all, so the cut would never leave its first shot.
  const [screenElement, setScreenElement] = React.useState(null);
  const screenSource = current && readyClip(current) ? readyClip(current).url : null;

  // Keyed on the source as well as the element. Advancing swaps the source on
  // the node React keeps, so nothing about the element itself changes — and a
  // dependency list that named only the element would start the first clip and
  // leave every clip after it loaded, paused and waiting.
  React.useEffect(() => {
    if (!screenElement) return undefined;
    if (playing && !holding && screenElement.paused) screenElement.play().catch(() => {});
    if (!playing && !screenElement.paused) screenElement.pause();
    return undefined;
  }, [screenElement, screenSource, playing, holding !== null]);

  React.useEffect(() => {
    if (!playing) return undefined;
    // A shot removed by another seat leaves the cut pointing at nothing. Falling
    // back to the top would silently replay the film from shot one.
    if (heldShot !== null && rows.findIndex((row) => row.shotId === heldShot) < 0) {
      stopPlaying();
      return undefined;
    }
    if (holding) {
      const held = setTimeout(() => {
        setHolding(null);
        if (holding.until === null) setPlaying(false);
        else setHeldShot(holding.until);
      }, holding.seconds * 1000);
      return () => clearTimeout(held);
    }
    // Anything that is not a playable clip is timed here, and so is a clip the
    // cut gives no time to: a zero-length clip would otherwise play its whole
    // file, because its out-point is already behind its in-point.
    if (current && (!readyClip(current) || current.playSeconds <= 0)) {
      const onward = setTimeout(advance, holdSecondsFor(current) * 1000);
      return () => clearTimeout(onward);
    }
    return undefined;
  }, [
    playing,
    holding !== null,
    holding && holding.until,
    holding && holding.seconds,
    current && current.shotId,
    current && current.playSeconds,
    current ? Boolean(readyClip(current)) : false,
    rows.length,
  ]);

  // ── Actions ──

  const submitGrade = () => {
    const draft = draftOf();
    const look = (draft.look || '').trim();
    const note = (draft.note || '').trim();
    if (look.length > LOOK_MAX || note.length > GRADE_NOTE_MAX) return;
    // The room edits the words; the plate is a render, and carrying it through
    // unchanged is what stops a wording edit from unpinning every keyframe.
    commit(send('set_grade', { grade: { look, note, plate: grade.plate || null } }));
  };

  const submitPrompt = () => {
    const draft = draftOf();
    const prompt = (draft.prompt || '').trim();
    const negativePrompt = (draft.negativePrompt || '').trim();
    if (!prompt || prompt.length > PROMPT_MAX || negativePrompt.length > NEGATIVE_PROMPT_MAX) return;
    commit(
      send('set_prompt', {
        shotId: current.shotId,
        prompt,
        negativePrompt,
        screenDirection: current.shot.screenDirection || 'none',
      }),
    );
  };

  const timingDraft = () => {
    const draft = draftOf();
    const durationSeconds = numberField(draft.durationSeconds);
    const speed = numberField(draft.speed);
    return {
      durationSeconds,
      speed,
      ok:
        durationSeconds !== null &&
        durationSeconds > 0 &&
        durationSeconds <= DURATION_MAX &&
        speed !== null &&
        speed > 0 &&
        speed <= SPEED_MAX,
    };
  };

  const submitTiming = () => {
    const { durationSeconds, speed, ok } = timingDraft();
    if (!ok) return;
    commit(send('set_timing', { shotId: current.shotId, durationSeconds, speed }));
  };

  const trimDraft = () => {
    const draft = draftOf();
    const startSeconds = numberField(draft.startSeconds);
    const durationSeconds = numberField(draft.durationSeconds);
    return {
      startSeconds,
      durationSeconds,
      ok:
        startSeconds !== null &&
        startSeconds >= 0 &&
        durationSeconds !== null &&
        durationSeconds > 0,
    };
  };

  const submitTrim = () => {
    const { startSeconds, durationSeconds, ok } = trimDraft();
    if (!ok) return;
    const range = current.clip.sourceRange;
    const rate = (range && range.duration && range.duration.rate) || project.fps || 24;
    commit(
      send('trim_clip', {
        shotId: current.shotId,
        trackIndex: cut.trackIndex,
        itemIndex: current.itemIndex,
        sourceRange: {
          startTime: { value: frameCount(startSeconds, rate), rate },
          duration: { value: frameCount(durationSeconds, rate), rate },
        },
      }),
    );
  };

  const submitBind = () => {
    const draft = draftOf();
    const role = (draft.role || '').trim();
    const entity = entities[draft.entityKey];
    if (!ROLE_PATTERN.test(role) || !entity) return;
    commit(send('bind_shot_entity', { shotId: current.shotId, role, entity }));
  };

  const unbind = (role) => send('unbind_shot_entity', { shotId: current.shotId, role });

  const submitNote = (shotId, atSeconds) => {
    const comment = (draftOf().comment || '').trim();
    if (!comment || comment.length > COMMENT_MAX) return;
    const rate = project.fps || 24;
    commit(
      send('add_marker', {
        markerId: mintId('mk_', 10),
        marker: { shotId, at: { value: frameCount(atSeconds, rate), rate }, comment },
      }),
    );
  };

  const resolveNote = (markerId) => send('resolve_marker', { markerId });

  /**
   * The room sees shots, and the track carries holds and dissolves between
   * them, so a move addresses positions the room never saw. Lifting one clip
   * out and dropping it in the other's place is a swap only when the two are
   * adjacent on the track; with anything between them that single move slides
   * the hold to the far side of the pair, so the second act puts the
   * neighbouring clip where the first one stood and nothing else moves.
   */
  const moveShot = (delta) => {
    const row = rows[index];
    const neighbour = rows[index + delta];
    if (!row || !neighbour) return;
    const from = row.itemIndex;
    const to = neighbour.itemIndex;
    const steps = [
      {
        name: 'reorder_shot',
        input: { trackIndex: cut.trackIndex, fromIndex: from, toIndex: to, clip: row.clip },
      },
    ];
    if (Math.abs(to - from) > 1) {
      steps.push({
        name: 'reorder_shot',
        input: {
          trackIndex: cut.trackIndex,
          fromIndex: to - delta,
          toIndex: from,
          clip: neighbour.clip,
        },
      });
    }
    runSteps(steps);
  };

  const removeShot = () => {
    setConfirming(null);
    send('remove_shot', {
      shotId: current.shotId,
      trackIndex: cut.trackIndex,
      itemIndex: current.itemIndex,
    });
  };

  const restore = () => {
    runSteps(restoreSteps(current.shotId, current.shot, current.drift));
  };

  // ── Pieces ──

  const standing = () => {
    const badges = [];
    if (rows.length === 0) {
      badges.push(
        <Badge key="empty" variant="neutral">
          no shots yet
        </Badge>,
      );
    }
    if (waiting > 0) {
      badges.push(
        <Badge key="waiting" variant="warning">
          {waiting} without a take
        </Badge>,
      );
    }
    if (stale > 0) {
      badges.push(
        <Badge key="stale" variant="danger">
          {stale} stale
        </Badge>,
      );
    }
    if (blind > 0) {
      badges.push(
        <Badge key="blind" variant="warning">
          {blind} {blind === 1 ? 'shot renders' : 'shots render'} without the cast
        </Badge>,
      );
    }
    if (continuity.length > 0) {
      badges.push(
        <Badge key="continuity" variant="warning">
          {continuity.length} continuity {continuity.length === 1 ? 'note' : 'notes'}
        </Badge>,
      );
    }
    if (openNotes.length > 0) {
      badges.push(
        <Badge key="notes" variant="info">
          {openNotes.length} open {openNotes.length === 1 ? 'note' : 'notes'}
        </Badge>,
      );
    }
    if (badges.length === 0 && rows.length > 0) {
      badges.push(
        <Badge key="settled" variant="success">
          every shot settled
        </Badge>,
      );
    }
    return badges;
  };

  const noticeBar = () => {
    if (!notice) return null;
    const border = notice.tone === 'danger' ? 'var(--ds-danger)' : 'var(--ds-border-strong)';
    return (
      <Panel
        padding="sm"
        style={{ borderColor: border, borderLeftWidth: '3px', borderLeftColor: border }}
      >
        <Row justify="between" align="start" gap="sm" wrap>
          <Text size="sm">{notice.text}</Text>
          <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </Row>
      </Panel>
    );
  };

  const clipOf = (row) => {
    const take = row.shot.selectedTake;
    return take ? clips[assetKey(take.asset)] : null;
  };

  const screenWord = () => {
    if (!current) return 'Nothing on the video track yet.';
    const take = current.shot.selectedTake;
    if (!take) {
      return (current.shot.name || 'This shot') + ' is ' + waitingFor(current.shot, grade.plate) + '.';
    }
    const shown = clipOf(current);
    if (shown && shown.status === 'refused') {
      return shown.message || 'The take could not be played here.';
    }
    return 'Loading the take…';
  };

  /**
   * The clip plays the part of its take the cut asks for, at the speed the cut
   * applies — a screen that played the whole file at 1× would be showing
   * something the film does not say.
   */
  const inPointOf = (row) => seconds(row.clip.sourceRange && row.clip.sourceRange.startTime);

  const trimTo = (row) => (event) => {
    const element = event.target;
    if (!element) return;
    element.playbackRate = row.speed;
    const from = inPointOf(row);
    // A seek past the end is clamped, and a clamped seek reads as ended — the
    // element would then rewind and play the whole file. Better to play it
    // untrimmed from the top than to play it untrimmed and claim otherwise.
    if (from > 0 && from < element.duration && element.currentTime < from) {
      element.currentTime = from;
    }
  };

  /**
   * The out-point is enforced whether or not the cut is running, because the
   * clip on screen is a clip of the film either way. Idle, it loops the range
   * the cut asks for — the element's own loop attribute restarts at zero and
   * plays material the cut trimmed away.
   */
  const stopAtOut = (row) => (event) => {
    const element = event.target;
    if (!element || row.sourceSeconds <= 0) return;
    const from = inPointOf(row);
    if (element.currentTime < from + row.sourceSeconds) return;
    if (playing) return advance();
    element.currentTime = from;
  };

  const screen = () => {
    const shown = current ? clipOf(current) : null;
    // With no take there is still the frame the clip will be animated from, and
    // showing it is how the room judges a still before paying for the motion.
    const frame =
      current && !current.shot.selectedTake && (current.shot.keyframe || {}).asset
        ? clips[assetKey(current.shot.keyframe.asset)]
        : null;
    return (
      <div style={{ ...SCREEN_STYLE, aspectRatio: ratio }}>
        {holding ? (
          <Text size="sm" color="inverse" style={{ padding: '16px' }}>
            {timecode(holding.seconds)} of black
          </Text>
        ) : shown && shown.status === 'ready' ? (
          <video
            src={shown.url}
            controls
            playsInline
            style={FILL_STYLE}
            ref={setScreenElement}
            onLoadedMetadata={trimTo(current)}
            onTimeUpdate={stopAtOut(current)}
            onEnded={playing ? advance : undefined}
          />
        ) : frame && frame.status === 'ready' ? (
          <img src={frame.url} alt="the frame this shot animates" style={FILL_STYLE} />
        ) : (
          <Text size="sm" color="inverse" style={{ padding: '16px' }}>
            {screenWord()}
          </Text>
        )}
      </div>
    );
  };

  /**
   * Watching the cut is what finds drift: identity, colour and direction all
   * read fine in one shot and wrong in sequence. The count of shots with no
   * take is on the button because those are the ones the sequence holds as
   * stills, and a room that does not know it is watching an animatic will
   * read a held frame as a shot that came back frozen.
   */
  const transport = () => {
    const held = rows.filter((row) => !row.shot.selectedTake).length;
    return (
      <Row gap="sm" align="center" wrap>
        <Button
          size="sm"
          variant={playing ? 'secondary' : 'primary'}
          onClick={() => (playing ? stopPlaying() : startPlaying())}
        >
          {playing ? 'Stop the cut' : 'Watch the cut'}
        </Button>
        <Text size="xs" color="muted">
          {playing
            ? 'Playing from ' + (current ? 'shot ' + current.position : 'the top') + ' to the end'
            : timecode(cut.runtime) + ' in ' + rows.length + (rows.length === 1 ? ' shot' : ' shots')}
          {held > 0
            ? ' · ' + held + (held === 1 ? ' shot holds' : ' shots hold') + ' a still, not a clip'
            : ''}
        </Text>
      </Row>
    );
  };

  const staleLine = () => {
    const restorable = current.drift.every((axis) => axis.restore !== null);
    return (
      <Row gap="sm" align="center" wrap>
        <Text size="sm">
          Take {current.shot.selectedTake.takeId} is stale — since it was rendered,{' '}
          {listOf(current.drift.map((axis) => axis.label))}.
        </Text>
        {readOnly ? null : restorable ? (
          <Button size="sm" variant="secondary" onClick={restore} disabled={busy}>
            Restore the shot to this take
          </Button>
        ) : (
          <Text size="xs" color="muted">
            The route or the conditioning moved, so only a re-render settles this one.
          </Text>
        )}
      </Row>
    );
  };

  const shotLine = () => {
    if (!current) return null;
    const status = takeState(current);
    const mine = notesOn(current.shotId);
    return (
      <Column gap="xs">
        <Row justify="between" align="baseline" wrap gap="sm">
          <Text weight="semibold">
            {index + 1}. {current.shot.name || current.shotId}
          </Text>
          <Row gap="xs" align="baseline" wrap>
            <Text size="xs" color="muted">
              {timecode(current.startSeconds)} →{' '}
              {timecode(current.startSeconds + current.playSeconds)}
              {current.speed !== 1 ? ' · ' + current.speed + '×' : ''}
            </Text>
            {status === 'waiting' ? (
              <Badge variant="warning">no take</Badge>
            ) : status === 'stale' ? (
              <Badge variant="danger">stale</Badge>
            ) : (
              <Badge variant="success">settled</Badge>
            )}
            {mine.length > 0 ? (
              <Badge variant="info">
                {mine.length} {mine.length === 1 ? 'note' : 'notes'}
              </Badge>
            ) : null}
          </Row>
        </Row>
        {status === 'stale' ? staleLine() : null}
        {blindBindings(current.shot).length > 0 ? (
          <Text size="sm" color="warning">
            {(current.shot.name || current.shotId) +
              ' binds ' +
              blindBindings(current.shot).join(', ') +
              ' and conditions on the prompt alone — a render sees none of them. Reference' +
              ' conditioning is what carries a binding into the frame.'}
          </Text>
        ) : null}
        {continuity
          .filter((note) => note.afterShotId === current.shotId || note.beforeShotId === current.shotId)
          .map((note) => (
            <Text key={note.kind + note.at} size="sm" color="warning">
              {note.text +
                (note.kind === 'direction_flip'
                  ? '. Sometimes the flip is the shot — if it is, this note is just read and left standing.'
                  : '.')}
            </Text>
          ))}
      </Column>
    );
  };

  const controls = () => (
    <Row gap="xs" wrap align="center">
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          toggleEditor('trim', {
            startSeconds: round(
              seconds(current.clip.sourceRange && current.clip.sourceRange.startTime),
              2,
            ),
            durationSeconds: round(current.sourceSeconds, 2),
          })
        }
      >
        Trim
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          toggleEditor('timing', {
            durationSeconds: current.shot.durationSeconds,
            speed: current.shot.speed,
          })
        }
      >
        Timing
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => toggleEditor('roles', { role: '', entityKey: entityKeys[0] })}
      >
        Roles
      </Button>
      <Button size="sm" variant="ghost" onClick={() => toggleEditor('note', { comment: '' })}>
        Note
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          toggleEditor('prompt', {
            prompt: current.shot.prompt || '',
            negativePrompt: current.shot.negativePrompt || '',
          })
        }
      >
        Prompt
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => toggleEditor('grade', { look: grade.look || '', note: grade.note || '' })}
      >
        Grade
      </Button>
      <Button size="sm" variant="ghost" disabled={index === 0 || busy} onClick={() => moveShot(-1)}>
        Move ←
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={index === rows.length - 1 || busy}
        onClick={() => moveShot(1)}
      >
        Move →
      </Button>
      {confirming === current.shotId ? (
        <Row gap="xs" align="center">
          <Text size="xs" color="muted">
            Remove the shot and its clip?
          </Text>
          <Button size="sm" variant="danger" onClick={removeShot}>
            Remove
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
            Keep
          </Button>
        </Row>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(current.shotId)}>
          Remove
        </Button>
      )}
    </Row>
  );

  const noteFields = (placeholder, onLeave) => (
    <Column gap="xs">
      <textarea
        style={{ ...AREA_STYLE, minHeight: '56px' }}
        value={draftOf().comment || ''}
        maxLength={COMMENT_MAX}
        placeholder={placeholder}
        onChange={(e) => patchDraft({ comment: e.target.value })}
      />
      <Row gap="xs">
        <Button size="sm" onClick={onLeave} disabled={!(draftOf().comment || '').trim()}>
          Leave the note
        </Button>
        <Button size="sm" variant="ghost" onClick={closeEditor}>
          Cancel
        </Button>
      </Row>
    </Column>
  );

  const shotEditor = () => {
    if (editor === null) return null;
    if (editor.kind === 'prompt') {
      return (
        <Panel padding="sm">
          <Column gap="xs">
            <textarea
              style={AREA_STYLE}
              value={draftOf().prompt || ''}
              maxLength={PROMPT_MAX}
              placeholder="What this shot shows"
              onChange={(e) => patchDraft({ prompt: e.target.value })}
            />
            <textarea
              style={{ ...AREA_STYLE, minHeight: '48px' }}
              value={draftOf().negativePrompt || ''}
              maxLength={NEGATIVE_PROMPT_MAX}
              placeholder="What to keep out of it"
              onChange={(e) => patchDraft({ negativePrompt: e.target.value })}
            />
            <Row gap="xs" align="center" wrap>
              <Button
                size="sm"
                onClick={submitPrompt}
                disabled={!(draftOf().prompt || '').trim()}
              >
                Save the prompt
              </Button>
              <Button size="sm" variant="ghost" onClick={closeEditor}>
                Cancel
              </Button>
              {current.shot.selectedTake ? (
                <Text size="xs" color="muted">
                  Saving a different prompt makes the selected take stale.
                </Text>
              ) : null}
            </Row>
          </Column>
        </Panel>
      );
    }
    if (editor.kind === 'timing') {
      return (
        <Panel padding="sm">
          <Column gap="xs">
            <Row gap="sm" wrap align="center">
              <Text size="sm" color="muted">
                Generated length
              </Text>
              <Input
                type="number"
                step="0.1"
                min="0.1"
                max={String(DURATION_MAX)}
                aria-label="generated length in seconds"
                style={{ width: '7rem' }}
                value={draftOf().durationSeconds}
                onChange={(e) => patchDraft({ durationSeconds: e.target.value })}
              />
              <Text size="sm" color="muted">
                seconds · speed
              </Text>
              <Input
                type="number"
                step="0.05"
                min="0.05"
                max={String(SPEED_MAX)}
                aria-label="playback speed"
                style={{ width: '7rem' }}
                value={draftOf().speed}
                onChange={(e) => patchDraft({ speed: e.target.value })}
              />
            </Row>
            {timingDraft().ok ? (
              <Text size="xs" color="muted">
                Speed is applied at assembly and costs no generation — below 1 plays slower.
              </Text>
            ) : (
              <Text size="xs" color="muted">
                A generated length runs above 0 and up to {DURATION_MAX} seconds; speed runs above 0
                and up to {SPEED_MAX}×.
              </Text>
            )}
            <Row gap="xs">
              <Button size="sm" onClick={submitTiming} disabled={!timingDraft().ok}>
                Save the timing
              </Button>
              <Button size="sm" variant="ghost" onClick={closeEditor}>
                Cancel
              </Button>
            </Row>
          </Column>
        </Panel>
      );
    }
    if (editor.kind === 'trim') {
      return (
        <Panel padding="sm">
          <Column gap="xs">
            <Row gap="sm" wrap align="center">
              <Text size="sm" color="muted">
                Starts at
              </Text>
              <Input
                type="number"
                step="0.1"
                min="0"
                aria-label="trim start in seconds"
                style={{ width: '7rem' }}
                value={draftOf().startSeconds}
                onChange={(e) => patchDraft({ startSeconds: e.target.value })}
              />
              <Text size="sm" color="muted">
                runs for
              </Text>
              <Input
                type="number"
                step="0.1"
                min="0.1"
                aria-label="trim duration in seconds"
                style={{ width: '7rem' }}
                value={draftOf().durationSeconds}
                onChange={(e) => patchDraft({ durationSeconds: e.target.value })}
              />
              <Text size="sm" color="muted">
                seconds of the take
              </Text>
            </Row>
            {trimDraft().ok ? (
              <Text size="xs" color="muted">
                A trim changes the cut, not the take — nothing is regenerated.
              </Text>
            ) : (
              <Text size="xs" color="muted">
                A trim starts at 0 seconds or later and runs for a length above 0.
              </Text>
            )}
            <Row gap="xs">
              <Button size="sm" onClick={submitTrim} disabled={!trimDraft().ok}>
                Save the trim
              </Button>
              <Button size="sm" variant="ghost" onClick={closeEditor}>
                Cancel
              </Button>
            </Row>
          </Column>
        </Panel>
      );
    }
    if (editor.kind === 'grade') {
      return (
        <Panel padding="sm">
          <Column gap="xs">
            {directorElsewhere ? (
              <Text size="xs" color="muted">
                The director owns the look. You can still set it — the platform does not stop you.
              </Text>
            ) : null}
            <Input
              value={draftOf().look || ''}
              maxLength={LOOK_MAX}
              placeholder="The look, applied to every shot at assembly"
              onChange={(e) => patchDraft({ look: e.target.value })}
            />
            <textarea
              style={AREA_STYLE}
              value={draftOf().note || ''}
              maxLength={GRADE_NOTE_MAX}
              placeholder="Why this look"
              onChange={(e) => patchDraft({ note: e.target.value })}
            />
            <Row gap="xs">
              <Button size="sm" onClick={submitGrade}>
                Set the grade
              </Button>
              <Button size="sm" variant="ghost" onClick={closeEditor}>
                Cancel
              </Button>
            </Row>
          </Column>
        </Panel>
      );
    }
    if (editor.kind === 'roles') {
      const bound = Object.keys(current.shot.entities || {}).sort();
      const draft = draftOf();
      const roleOk = ROLE_PATTERN.test((draft.role || '').trim());
      return (
        <Panel padding="sm">
          <Column gap="sm">
            {bound.length > 0 ? (
              <Column gap="xs">
                {bound.map((role) => {
                  const binding = current.shot.entities[role];
                  return (
                    <Row key={role} gap="sm" align="center" justify="between" wrap>
                      <Text size="sm">
                        {role} → {binding.name} {pinSummary(binding)}
                      </Text>
                      <Button size="sm" variant="ghost" onClick={() => unbind(role)}>
                        Unbind
                      </Button>
                    </Row>
                  );
                })}
              </Column>
            ) : (
              <Text size="sm" color="muted">
                Nothing bound to this shot yet.
              </Text>
            )}
            {entityKeys.length === 0 ? (
              <Text size="sm" color="muted">
                The entity library is empty. The agent writes a reference pack to Memory and pins it
                there before a shot can bind it.
              </Text>
            ) : (
              <Column gap="xs">
                <FilterChips
                  options={entityKeys.map((key) => ({
                    value: key,
                    label: entities[key].name + ' ' + pinSummary(entities[key]),
                  }))}
                  value={draft.entityKey}
                  onChange={(value) => patchDraft({ entityKey: value })}
                />
                <Row gap="xs" align="center" wrap>
                  <Input
                    value={draft.role || ''}
                    maxLength={24}
                    placeholder="role, e.g. lead"
                    style={{ width: '11rem' }}
                    onChange={(e) => patchDraft({ role: e.target.value })}
                  />
                  <Button size="sm" onClick={submitBind} disabled={!roleOk || !entities[draft.entityKey]}>
                    Bind
                  </Button>
                  <Button size="sm" variant="ghost" onClick={closeEditor}>
                    Close
                  </Button>
                </Row>
                {(draft.role || '').trim() && !roleOk ? (
                  <Text size="xs" color="muted">
                    A role is lowercase letters, digits and underscores, two to twenty-four
                    characters, starting with a letter.
                  </Text>
                ) : null}
              </Column>
            )}
          </Column>
        </Panel>
      );
    }
    if (editor.kind === 'note') {
      return (
        <Panel padding="sm">
          {noteFields('A note on this shot, at ' + timecode(current.startSeconds), () =>
            submitNote(current.shotId, current.startSeconds),
          )}
        </Panel>
      );
    }
    return null;
  };

  const tile = (entry) => {
    const key = entry.kind + '-' + entry.itemIndex;
    if (entry.kind === 'gap') {
      return (
        <div key={key} style={{ width: tileWidth(entry.playSeconds), flex: '0 0 auto' }}>
          <div style={{ ...FRAME_STYLE, background: 'var(--ds-bg-sunken)' }}>
            <Text size="xs" color="muted">
              hold {round(entry.playSeconds, 1)}s
            </Text>
          </div>
        </div>
      );
    }
    if (entry.kind === 'transition') {
      return (
        <div key={key} style={{ width: '56px', flex: '0 0 auto' }}>
          <div style={{ ...FRAME_STYLE, background: 'var(--ds-bg-sunken)' }}>
            <Text size="xs" color="muted">
              {entry.item.style}
            </Text>
          </div>
        </div>
      );
    }
    const status = takeState(entry);
    const shown = clipOf(entry);
    const inHand = current !== null && entry.shotId === current.shotId;
    const mine = notesOn(entry.shotId);
    return (
      <div
        key={key}
        onClick={() => hold(entry.shotId)}
        style={{ width: tileWidth(entry.playSeconds), flex: '0 0 auto', cursor: 'pointer' }}
      >
        <div
          style={{
            ...FRAME_STYLE,
            outline: inHand ? '2px solid var(--ds-accent-primary)' : '1px solid var(--ds-border-default)',
          }}
        >
          {shown && shown.status === 'ready' ? (
            <video src={shown.url} muted playsInline preload="metadata" style={FILL_STYLE} />
          ) : (
            <Text size="xs" color="inverse">
              {status === 'waiting' ? 'no take' : '▶'}
            </Text>
          )}
        </div>
        <Row gap="xs" align="baseline" wrap>
          <Text size="xs" weight={inHand ? 'semibold' : 'normal'} color={inHand ? 'primary' : 'muted'}>
            {entry.position}. {entry.shot.name || entry.shotId}
          </Text>
          {status === 'stale' ? <Badge variant="danger">stale</Badge> : null}
          {mine.length > 0 ? <Badge variant="info">{mine.length}</Badge> : null}
        </Row>
      </div>
    );
  };

  const underTracks = () =>
    cut.under.map((track) => (
      <Row key={track.name} gap="xs" align="center" wrap>
        <Text size="xs" weight="semibold" color="muted">
          {track.name}
        </Text>
        {track.entries.map((entry) => (
          <Badge key={entry.kind + '-' + entry.itemIndex} variant="neutral">
            {entry.kind === 'audio'
              ? fileName(entry.item.asset) + ' · ' + round(entry.item.gainDb, 1) + ' dB'
              : entry.kind === 'gap'
                ? 'silence ' + round(entry.playSeconds, 1) + 's'
                : entry.item.style}
          </Badge>
        ))}
      </Row>
    ));

  const notesBlock = () => (
    <Column gap="xs">
      <Row gap="sm" align="baseline" wrap justify="between">
        <Text weight="semibold" size="sm">
          Open notes ({openNotes.length})
        </Text>
        {readOnly || isOpen('filmNote') ? null : (
          <Button size="sm" variant="ghost" onClick={() => openEditor('filmNote', { comment: '' })}>
            Leave a note on the film
          </Button>
        )}
      </Row>
      {isOpen('filmNote') ? (
        <Panel padding="sm">
          {noteFields('A note on the cut as a whole', () => submitNote(null, 0))}
        </Panel>
      ) : null}
      {openNotes.length === 0 ? (
        <Text size="sm" color="muted">
          Nothing open. A note leaves the cut when it is resolved, and the journal keeps what it
          said.
        </Text>
      ) : (
        <ScrollArea maxHeight="12rem">
          <Column gap="xs">
            {openNotes.map((markerId) => {
              const marker = markers[markerId];
              const onShot = marker.shotId ? shots[marker.shotId] : null;
              return (
                <Row key={markerId} gap="sm" align="baseline" justify="between" wrap>
                  <Text size="sm">
                    {timecode(seconds(marker.at))}
                    {onShot ? ' · ' + (onShot.name || marker.shotId) : ''} — {marker.comment}
                  </Text>
                  <Row gap="xs">
                    {onShot ? (
                      <Button size="sm" variant="ghost" onClick={() => hold(marker.shotId)}>
                        Show
                      </Button>
                    ) : null}
                    {readOnly ? null : (
                      <Button size="sm" variant="ghost" onClick={() => resolveNote(markerId)}>
                        Resolve
                      </Button>
                    )}
                  </Row>
                </Row>
              );
            })}
          </Column>
        </ScrollArea>
      )}
    </Column>
  );

  const seatLine = seats
    .filter((seat) => seat && seat.roleId && seat.displayName)
    .map((seat) => seat.roleId + ': ' + seat.displayName)
    .join(' · ');

  const worldThumb = (reactKey, pin, label) => {
    const held = pin ? clips[assetKey(pin)] : null;
    return (
      <Column key={reactKey} gap="xs">
        <div style={{ ...FRAME_STYLE, width: '96px' }}>
          {held && held.status === 'ready' ? (
            <img src={held.url} alt={label} style={FILL_STYLE} />
          ) : (
            <Text size="xs" color="muted">
              {pin ? '…' : 'no plate'}
            </Text>
          )}
        </div>
        <Text size="xs" color="muted">
          {label}
        </Text>
      </Column>
    );
  };

  /**
   * The film's world, visible before a single shot is: the plates the room
   * paid for live in the grade and the library, and a board that hides them
   * shows an authored film as an empty one.
   */
  const world = () => {
    const awaiting = Object.keys(casting)
      .sort()
      .filter((key) => !entities[key]);
    if (!grade.plate && entityKeys.length === 0 && awaiting.length === 0) return null;
    return (
      <Row gap="sm" wrap align="start">
        {grade.plate ? worldThumb('grade', grade.plate, 'the grade') : null}
        {entityKeys.map((key) => {
          const entity = entities[key] || {};
          const pins = entity.pins || [];
          return worldThumb(
            key,
            pins[0] || null,
            (entity.name || key) + ' \u00b7 ' + (entity.kind || 'entity'),
          );
        })}
        {awaiting.map((key) => {
          const line = casting[key] || {};
          return worldThumb(
            'cast:' + key,
            null,
            (line.name || key) + ' \u00b7 ' + (line.kind || 'entity') + ' \u2014 cast, awaiting its plate',
          );
        })}
      </Row>
    );
  };

  return (
    <Card elevated padding="lg">
      <Column gap="md">
        <Row justify="between" align="start" wrap gap="sm">
          <Column gap="xs">
            <Heading level={3}>{project.title || 'Untitled film'}</Heading>
            <Text size="sm" color="muted">
              {project.logline || 'No logline yet'}
            </Text>
            <Text size="xs" color="muted">
              {grade.look || 'No look agreed yet'}
            </Text>
            {grade.plate ? null : (
              <Text size="xs" color="muted">
                No grade plate — shots cannot be given a recipe until the film has one.
              </Text>
            )}
          </Column>
          <Column gap="xs" align="end">
            <Row gap="xs" wrap justify="end">
              <Badge variant="neutral">
                {project.aspectRatio || '16:9'} · {project.fps || 24} fps
              </Badge>
              {busy ? <Badge variant="neutral">sending…</Badge> : null}
              {standing()}
            </Row>
            <Text size="xs" color="muted">
              {rows.length} {rows.length === 1 ? 'shot' : 'shots'} · {timecode(cut.runtime)}{' '}
              assembled
            </Text>
          </Column>
        </Row>

        {world()}

        {seatLine ? (
          <Text size="xs" color="muted">
            {seatLine}
            {appletRoles.length > 0 ? ' · you: ' + appletRoles.join(', ') : ''}
          </Text>
        ) : null}

        {readOnly ? (
          <Text size="xs" color="muted">
            View only — you can watch the cut, but only editors change it.
          </Text>
        ) : null}

        {noticeBar()}

        {cut.entries.length === 0 ? (
          <EmptyState
            title="No shots yet"
            description="A shot is one generated clip. The agent adds shots to the cut — ask for the opening shot in the chat and it appears here, in timeline order."
          />
        ) : (
          <Column gap="sm">
            {screen()}
            {transport()}
            {shotLine()}
            {readOnly || current === null ? null : controls()}
            {readOnly || current === null ? null : shotEditor()}
            <div style={STRIP_STYLE}>{cut.entries.map((entry) => tile(entry))}</div>
            {underTracks()}
          </Column>
        )}

        {notesBlock()}
      </Column>
    </Card>
  );
}
`;

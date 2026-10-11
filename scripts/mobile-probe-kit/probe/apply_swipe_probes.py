#!/usr/bin/env python3
"""Add the play drawer's swipe and swipe-down probes on top of apply_probes.py. See docs/mobile-visible-performance.md.

    apply_swipe_probes.py <repo-root>

A swipe between climbs and the pull-down close both run on the UI thread, so
these probes stamp the UI thread's clock (`uiWallMs`) and sample the gesture's
own shared value at every UI frame (`ui-frames`). What each event is for:

  swipe-begin              the carousel's pan activated (10 px of travel)
  swipe-release            finger up: offset, velocity, and which way it commits
  swipe-dropped            finger up while the last fling was still in progress,
                           so the swipe did nothing. `wouldCommit` says what it
                           would have done
  swipe-settled            the fling finished: outgoing board off screen
  swipe-commit-js(-done)   the JS thread started and finished changing the climb
  swipe-reset-js           the host put the carousel back to rest
  swipe-fling-ui / swipe-reset-ui   the same two edges as the UI thread saw them
  peek-direction-ui        the swipe changed sides, so the incoming board changes
  carousel-render          which climb the board and the incoming board hold, and how far
                           the incoming board travels to reach the middle (`slide`)
  dismiss-begin / -release / -settled / -interrupted   the pull-down close
  dismiss-complete-js, dismiss-route-dismiss-js, play-route-unmounted
  queue-limited            the `perf-probe-queue-5` marker cut the restored queue
                           down for this launch; the saved queue is untouched

Every edit asserts its anchor occurs once, like apply_probes.py.
"""
import sys

if len(sys.argv) != 2:
    sys.exit(__doc__)
M = sys.argv[1].rstrip("/") + "/packages/mobile/"


def edit(path, pairs, imports=()):
    text = open(M + path).read()
    for old, new in pairs:
        assert text.count(old) == 1, (path, old[:70], text.count(old))
        text = text.replace(old, new)
    for import_line in imports:
        if import_line not in text:
            first_import = text.index("import ")
            text = text[:first_import] + import_line + "\n" + text[first_import:]
    open(M + path, "w").write(text)


edit("src/components/play-drawer/use-carousel-gesture.ts", [
("""      .onStart(() => {
        'worklet';
        hasTriggeredHaptic.value = false;
""",
"""      .onStart(() => {
        'worklet';
        hasTriggeredHaptic.value = false;
        perfProbeUiFramesStart('swipe', translateX, isAnimating);
        perfProbeUi('swipe-begin', { ignored: isAnimating.value });
"""),
("""      .onEnd((event) => {
        'worklet';
        if (isAnimating.value) return;

        const offset = translateX.value;
        const skipAnimation = reduceMotionSV.value;
        const velocity = event.velocityX ?? 0;
        const commitDirection = carouselCommitDirection(offset, velocity, SWIPE_THRESHOLD);
""",
"""      .onEnd((event) => {
        'worklet';
        if (isAnimating.value) {
          perfProbeUi('swipe-dropped', {
            translationX: Math.round(event.translationX),
            velocityX: Math.round(event.velocityX ?? 0),
            wouldCommit:
              carouselCommitDirection(event.translationX, event.velocityX ?? 0, SWIPE_THRESHOLD) ?? 'none',
          });
          return;
        }

        const offset = translateX.value;
        const skipAnimation = reduceMotionSV.value;
        const velocity = event.velocityX ?? 0;
        const commitDirection = carouselCommitDirection(offset, velocity, SWIPE_THRESHOLD);
        perfProbeUi('swipe-release', {
          offset: Math.round(offset),
          velocityX: Math.round(velocity),
          commit: commitDirection ?? 'none',
          canNext: canSwipeNextSV.value,
          canPrevious: canSwipePreviousSV.value,
        });
"""),
("""                if (finished) runOnJS(commitAtEnd)('next');
""",
"""                perfProbeUi(finished ? 'swipe-settled' : 'swipe-fling-interrupted', { direction: 'next' });
                if (finished) runOnJS(commitAtEnd)('next');
"""),
("""                if (finished) runOnJS(commitAtEnd)('previous');
""",
"""                perfProbeUi(finished ? 'swipe-settled' : 'swipe-fling-interrupted', { direction: 'previous' });
                if (finished) runOnJS(commitAtEnd)('previous');
"""),
("""  const commitAtEnd = (direction: 'next' | 'previous') => {
    if (direction === 'next') {
      callbacksRef.current.onSwipeNext();
    } else {
      callbacksRef.current.onSwipePrevious();
    }
""",
"""  const commitAtEnd = (direction: 'next' | 'previous') => {
    perfProbe('swipe-commit-js', { direction });
    if (direction === 'next') {
      callbacksRef.current.onSwipeNext();
    } else {
      callbacksRef.current.onSwipePrevious();
    }
    perfProbe('swipe-commit-js-done', { direction });
"""),
], ["import { perfProbe, perfProbeUi, perfProbeUiFramesStart } from '../../lib/perf-probe';"])

# apply_probes.py already imports `perfProbe` into the carousel; importing a name twice does not compile.
edit("src/components/play-drawer/SwipeBoardCarousel.tsx", [
("""    (direction) => {
      runOnJS(setJsDirection)(direction);
    },
""",
"""    (direction) => {
      perfProbeUi('peek-direction-ui', { direction });
      runOnJS(setJsDirection)(direction);
    },
"""),
("""      if (animating !== previous) runOnJS(handleAnimatingChange)(animating);
""",
"""      if (animating !== previous) {
        perfProbeUi(animating ? 'swipe-fling-ui' : 'swipe-reset-ui');
        runOnJS(handleAnimatingChange)(animating);
      }
"""),
("""  const composedGesture = React.useMemo(
""",
"""  perfProbe('carousel-render', {
    slide: Math.round(boardWidthForSwipe),
    direction: jsDirection,
    committing: isCommitting,
    current: perfProbeId(currentFrames),
    peek: perfProbeId(peekFrames),
    next: perfProbeId(nextFrames),
    previous: perfProbeId(prevFrames),
  });
  const composedGesture = React.useMemo(
"""),
], ["import { perfProbeId, perfProbeUi } from '../../lib/perf-probe';"])

drawer = "src/components/play-drawer/PlayDrawer.tsx"
edit(drawer, [
("""    if (swipeIsAnimating.value) {
      swipeTranslateX.value = 0;
      swipeIsAnimating.value = false;
    }
  }, [displayedQueueItemUuid, swipeIsAnimating, swipeTranslateX]);
""",
"""    if (swipeIsAnimating.value) {
      perfProbe('swipe-reset-js', { queue: queue.length });
      swipeTranslateX.value = 0;
      swipeIsAnimating.value = false;
    }
  }, [displayedQueueItemUuid, swipeIsAnimating, swipeTranslateX]);
"""),
], ["import { perfProbe } from '../../lib/perf-probe';"])
# How often the whole drawer renders per swipe. apply_launch_markers.py adds the same line; do not add it twice.
drawer_text = open(M + drawer).read()
if "perfProbe('render', { c: 'PlayDrawer' });" not in drawer_text:
    signature = "export function PlayDrawer({"
    assert drawer_text.count(signature) == 1
    position = drawer_text.index("\n", drawer_text.index(signature)) + 1
    while True:
        line_end = drawer_text.index("\n", position)
        line = drawer_text[position:line_end]
        if line.startswith("}") and line.rstrip().endswith("{"):
            break
        position = line_end + 1
    drawer_text = drawer_text[:line_end] + "\n  perfProbe('render', { c: 'PlayDrawer' });" + drawer_text[line_end:]
    open(M + drawer, "w").write(drawer_text)

edit("src/components/play-drawer/use-drawer-dismiss-gesture.ts", [
("""      .onUpdate((event) => {
        'worklet';
        if (isDismissing.value) return;
        // Once the carousel owns the gesture""",
"""      .onStart(() => {
        'worklet';
        perfProbeUiFramesStart('dismiss', translateY, isDismissing);
        perfProbeUi('dismiss-begin', { atTop: startedAtTop.value, scrollY: Math.round(scrollYSV.value) });
      })
      .onUpdate((event) => {
        'worklet';
        if (isDismissing.value) return;
        // Once the carousel owns the gesture"""),
("""        if (committed) {
          isDismissing.value = true;
""",
"""        perfProbeUi('dismiss-release', {
          committed,
          translateY: Math.round(translateY.value),
          velocityY: Math.round(event.velocityY),
          height: dismissHeight ? Math.round(dismissHeight.value) : -1,
        });
        if (committed) {
          isDismissing.value = true;
"""),
("""              (finished) => {
                if (finished) {
                  runOnJS(commitDismiss)();
""",
"""              (finished) => {
                perfProbeUi(finished ? 'dismiss-settled' : 'dismiss-interrupted');
                if (finished) {
                  perfProbeUiFramesStop('settled');
                  runOnJS(commitDismiss)();
"""),
], ["import { perfProbeUi, perfProbeUiFramesStart, perfProbeUiFramesStop } from '../../lib/perf-probe';"])

edit("src/components/play-drawer/use-play-swipe-dismiss.ts", [
("""    removalRequestedRef.current = true;
    setOffscreen(true);
""",
"""    removalRequestedRef.current = true;
    perfProbe('dismiss-complete-js');
    setOffscreen(true);
"""),
("""        if (navigation.isFocused()) {
          router.dismiss();
        } else {
          // A different modal covered""",
"""        if (navigation.isFocused()) {
          perfProbe('dismiss-route-dismiss-js');
          router.dismiss();
        } else {
          // A different modal covered"""),
], ["import { perfProbe } from '../../lib/perf-probe';"])

# apply_probes.py already imports `perfProbe` into the route.
edit("app/play.tsx", [
("""    const handle = requestAnimationFrame(() => setContentMounted(true));
    return () => cancelAnimationFrame(handle);
""",
"""    const handle = requestAnimationFrame(() => setContentMounted(true));
    return () => {
      perfProbe('play-route-unmounted');
      cancelAnimationFrame(handle);
    };
"""),
])

# A short queue for one launch (the `perf-probe-queue-5` marker), without touching the saved one.
edit("src/lib/queue-snapshot-store.ts", [
("""const QUEUE_SNAPSHOT_KEY = 'boardsesh_local_queue_snapshot_v1';
""",
"""const QUEUE_SNAPSHOT_KEY = 'boardsesh_local_queue_snapshot_v1';
const QUEUE_SNAPSHOT_WRITE_KEY = PERF_PROBE_QUEUE_LIMIT > 0 ? `${QUEUE_SNAPSHOT_KEY}_probe` : QUEUE_SNAPSHOT_KEY;

function limitQueueForProbe(snapshot: LocalQueueSnapshot): LocalQueueSnapshot {
  const currentIndex = snapshot.queue.findIndex((item) => item.uuid === snapshot.currentClimbQueueItem?.uuid);
  const end = currentIndex < 0 ? snapshot.queue.length : currentIndex + 1;
  const queue = snapshot.queue.slice(Math.max(0, end - PERF_PROBE_QUEUE_LIMIT), end);
  perfProbe('queue-limited', { from: snapshot.queue.length, to: queue.length });
  return { ...snapshot, queue };
}
"""),
("""  const snapshot = await getPreference<LocalQueueSnapshot>(QUEUE_SNAPSHOT_KEY);
  if (!snapshot) return null;
""",
"""  const storedSnapshot = await getPreference<LocalQueueSnapshot>(QUEUE_SNAPSHOT_KEY);
  const snapshot = storedSnapshot && PERF_PROBE_QUEUE_LIMIT > 0 ? limitQueueForProbe(storedSnapshot) : storedSnapshot;
  if (!snapshot) return null;
"""),
("setPreference(QUEUE_SNAPSHOT_KEY, references)", "setPreference(QUEUE_SNAPSHOT_WRITE_KEY, references)"),
("removePreference(QUEUE_SNAPSHOT_KEY)", "removePreference(QUEUE_SNAPSHOT_WRITE_KEY)"),
], ["import { PERF_PROBE_QUEUE_LIMIT, perfProbe } from './perf-probe';"])

print("swipe probes applied")

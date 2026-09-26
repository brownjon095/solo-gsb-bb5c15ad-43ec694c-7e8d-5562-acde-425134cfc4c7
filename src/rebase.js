/**
 * Rebase rehearsal: move a pending change patch onto a new document version.
 *
 * The client holds `patch` — RFC 6902 operations expressed against the
 * original `base` — while the platform has already advanced to `onto`. This
 * module recomputes the client's changes relative to the new version:
 *
 *  1. The base -> onto delta is converted into merge-engine BASE-COORDINATE
 *     operations (diffBaseCoordinates). Object members are compared in
 *     dictionary order; arrays are aligned by a longest common subsequence of
 *     deeply equal elements: matched elements keep their base identity,
 *     every unmatched base element becomes a `remove` at its base index and
 *     every unmatched onto element becomes an `add` addressed to the gap
 *     before the next kept base element (or the append gap). Consecutive
 *     insertions between the same kept neighbours therefore share one gap
 *     and the merge engine accumulates them in onto order.
 *  2. The generated operations (side "onto") and the client patch (side
 *     "patch") are merged by the regular base-coordinate engine. Same-gap
 *     insertions land onto-first / client-second, mirroring a git rebase
 *     that replays pending commits on top of the new version; client writes
 *     that are already present in onto are deduplicated.
 *  3. On a clean merge the client changes are re-expressed as
 *     `rebasedPatch`, a deterministic RFC 6902 patch relative to `onto`.
 *     The patch is replayed server-side and only returned when the replay
 *     produces exactly the merged document; a mismatch is a RebaseError.
 *
 * On conflict no executable patch is produced: the result carries the
 * engine's structured conflicts (reason, normalized path, both sides'
 * operation indices — "onto" for the generated base->onto operations,
 * "patch" for the client-submitted ones).
 */

import { mergePatches, deepEqual, formatPointer } from './merge.js';
import { diffDocuments, applyPatch, lcsPairs } from './roundtrip.js';

export class RebaseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RebaseError';
    this.code = details.code || 'REBASE_ERROR';
    this.details = details;
  }
}

/* -------------------- base-coordinate document diff --------------------- */

function isContainer(value) {
  return value !== null && typeof value === 'object';
}

/**
 * Append the base-coordinate operations that transform base into onto at
 * `segments`. Mirrors diffValues in roundtrip.js, except that arrays are
 * emitted for the merge engine's base-coordinate model instead of as a
 * sequentially-appliable RFC 6902 patch.
 */
function diffValues(base, onto, segments, out) {
  if (deepEqual(base, onto)) return;

  const baseIsArray = Array.isArray(base);
  const ontoIsArray = Array.isArray(onto);

  if (baseIsArray || ontoIsArray) {
    if (baseIsArray !== ontoIsArray) {
      // Container kind change (array <-> object) at this path: rewrite wholesale.
      out.push({ op: 'replace', path: formatPointer(segments), value: structuredClone(onto) });
      return;
    }
    diffArray(base, onto, segments, out);
    return;
  }

  if (isContainer(base) && isContainer(onto)) {
    diffObject(base, onto, segments, out);
    return;
  }

  // Scalar (or null) change, including a replace of the document root ("").
  out.push({ op: 'replace', path: formatPointer(segments), value: structuredClone(onto) });
}

function diffObject(base, onto, segments, out) {
  const keys = new Set([...Object.keys(base), ...Object.keys(onto)]);
  // Dictionary order: plain Array.sort compares by UTF-16 code units, which is
  // locale-independent and stable across runs.
  for (const key of [...keys].sort()) {
    const child = [...segments, key];
    const inBase = Object.prototype.hasOwnProperty.call(base, key);
    const inOnto = Object.prototype.hasOwnProperty.call(onto, key);
    if (inBase && inOnto) {
      diffValues(base[key], onto[key], child, out);
    } else if (inOnto) {
      out.push({ op: 'add', path: formatPointer(child), value: structuredClone(onto[key]) });
    } else {
      out.push({ op: 'remove', path: formatPointer(child) });
    }
  }
}

function diffArray(base, onto, segments, out) {
  const pairs = lcsPairs(base, onto);
  const keptBase = new Set(pairs.map(([i]) => i));

  // Removals carry their BASE index: the merge engine resolves every index in
  // base coordinates, so emission order cannot cause index drift.
  for (let i = 0; i < base.length; i++) {
    if (!keptBase.has(i)) {
      out.push({ op: 'remove', path: formatPointer([...segments, String(i)]) });
    }
  }

  // Insertions are addressed to the gap before the next kept base element (or
  // the append gap when no kept element follows). The gap is non-decreasing
  // in onto order, so consecutive insertions between the same kept neighbours
  // share one gap and the engine accumulates them in onto order.
  let p = 0; // next kept pair
  for (let j = 0; j < onto.length; j++) {
    if (p < pairs.length && pairs[p][1] === j) {
      p++;
      continue;
    }
    const gap = p < pairs.length ? pairs[p][0] : base.length;
    out.push({
      op: 'add',
      path: formatPointer([...segments, String(gap)]),
      value: structuredClone(onto[j]),
    });
  }
}

/**
 * Pure base-coordinate diff (add/remove/replace only) between two JSON
 * values. Applying the result to `base` with the merge engine (as either
 * side of a merge) yields `onto`.
 */
export function diffBaseCoordinates(base, onto) {
  const out = [];
  diffValues(base, onto, [], out);
  return out;
}

/* --------------------------------- entry --------------------------------- */

/**
 * Rebase `patch` (expressed against `base`) onto the `onto` document.
 *
 * Returns { status, merged, rebasedPatch, conflicts, stats }:
 *  - "clean":    `merged` is the three-way merge result and `rebasedPatch`
 *                an RFC 6902 patch that transforms `onto` into `merged`
 *                (replayed server-side for verification);
 *  - "conflict": `merged` / `rebasedPatch` are null and `conflicts` lists
 *                the structured clashes; no executable patch is produced.
 *
 * PatchError from the merge engine propagates with side labels "onto" /
 * "patch" (a client patch that does not apply to `base` reports "patch").
 */
export function rebasePatch(base, patch, onto) {
  const ontoOps = diffBaseCoordinates(base, onto);
  const result = mergePatches(base, ontoOps, patch, { sides: ['onto', 'patch'] });
  const stats = { ...result.stats, rebased: 0 };

  if (result.status === 'conflict') {
    return {
      status: 'conflict',
      merged: null,
      rebasedPatch: null,
      conflicts: result.conflicts,
      stats,
    };
  }

  const rebasedPatch = diffDocuments(onto, result.merged);
  const replayed = applyPatch(onto, rebasedPatch);
  if (!deepEqual(replayed, result.merged)) {
    throw new RebaseError('rebased patch replay did not produce the merged document', {
      code: 'REBASE_REPLAY_MISMATCH',
    });
  }
  stats.rebased = rebasedPatch.length;

  return {
    status: 'clean',
    merged: result.merged,
    rebasedPatch,
    conflicts: [],
    stats,
  };
}

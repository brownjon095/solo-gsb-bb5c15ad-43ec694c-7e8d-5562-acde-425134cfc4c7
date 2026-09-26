import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { diffBaseCoordinates, rebasePatch } from '../src/rebase.js';
import { mergePatches } from '../src/merge.js';
import { applyPatch } from '../src/roundtrip.js';
import { EXAMPLE_REBASE_REQUEST } from '../src/example.js';

/* --------------------- diffBaseCoordinates (unit) ----------------------- */

test('base-coordinate diff: object members in dictionary order with escaping', () => {
  const ops = diffBaseCoordinates(
    { a: 1, b: { x: 1, y: 2 }, gone: 4, 'a/b': 1 },
    { a: 1, b: { x: 9, z: 5 }, c: 3, 'a/b': 7 },
  );
  assert.deepEqual(ops, [
    { op: 'replace', path: '/a~1b', value: 7 },
    { op: 'replace', path: '/b/x', value: 9 },
    { op: 'remove', path: '/b/y' },
    { op: 'add', path: '/b/z', value: 5 },
    { op: 'add', path: '/c', value: 3 },
    { op: 'remove', path: '/gone' },
  ]);
});

test('base-coordinate diff: arrays keep deep-equal elements, remove at base indices', () => {
  // b is unmatched -> removed at its BASE index; x and y are consecutive
  // insertions between kept neighbours a and c -> both addressed to the gap
  // before c (base index 2).
  const ops = diffBaseCoordinates({ l: ['a', 'b', 'c'] }, { l: ['a', 'x', 'y', 'c'] });
  assert.deepEqual(ops, [
    { op: 'remove', path: '/l/1' },
    { op: 'add', path: '/l/2', value: 'x' },
    { op: 'add', path: '/l/2', value: 'y' },
  ]);
});

test('base-coordinate diff: prepend/append gaps and duplicate-element alignment', () => {
  assert.deepEqual(diffBaseCoordinates([1, 2], [0, 1, 2, 3]), [
    { op: 'add', path: '/0', value: 0 },
    { op: 'add', path: '/2', value: 3 },
  ]);
  // Stable LCS tie-break keeps base 0,3,4; the extra trailing 1 lands in the
  // append gap (base length 5).
  assert.deepEqual(diffBaseCoordinates([1, 1, 1, 2, 1], [1, 2, 1, 1]), [
    { op: 'remove', path: '/1' },
    { op: 'remove', path: '/2' },
    { op: 'add', path: '/5', value: 1 },
  ]);
  // Everything unmatched: removals at base indices, insertions share the
  // append gap and accumulate in onto order.
  assert.deepEqual(diffBaseCoordinates(['a', 'b'], ['x', 'y']), [
    { op: 'remove', path: '/0' },
    { op: 'remove', path: '/1' },
    { op: 'add', path: '/2', value: 'x' },
    { op: 'add', path: '/2', value: 'y' },
  ]);
});

test('base-coordinate diff: container kind change and root replace', () => {
  assert.deepEqual(diffBaseCoordinates({ x: [1] }, { x: { a: 1 } }), [
    { op: 'replace', path: '/x', value: { a: 1 } },
  ]);
  assert.deepEqual(diffBaseCoordinates(42, { a: 1 }), [
    { op: 'replace', path: '', value: { a: 1 } },
  ]);
  assert.deepEqual(diffBaseCoordinates({ k: [1] }, { k: [1] }), []);
});

test('base-coordinate diff applied by the merge engine reproduces onto', () => {
  const cases = [
    [{ l: [1, 2, 3, 2] }, { l: [2, 3, 2, 9] }],
    [
      { l: [{ n: 1, x: 'a' }, { n: 2 }, { n: 3 }], m: [[1, 2], [3]] },
      { l: [{ n: 0 }, { n: 1, x: 'a' }, { n: 3, tag: true }, { n: 9 }], m: [[2, 1], [3], [4]] },
    ],
    [42, { a: 1 }],
    [{ a: 1 }, [1, 2]],
    [[null], { k: null }],
    [{ a: 1, b: { c: [1, 2] } }, { b: { c: [2, 1, 3], d: null }, z: 'new' }],
  ];
  for (const [base, onto] of cases) {
    const ops = diffBaseCoordinates(base, onto);
    const result = mergePatches(base, ops, []);
    assert.equal(result.status, 'clean');
    assert.deepEqual(result.merged, onto);
  }
});

/* -------------------------- rebasePatch (unit) --------------------------- */

test('rebase relocates deep edits by element identity and consecutive inserts', () => {
  const base = { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], mode: 'ha' };
  const onto = { list: [{ id: 'a' }, { id: 'x' }, { id: 'y' }, { id: 'c' }], mode: 'ha' };
  const patch = [{ op: 'replace', path: '/list/2/id', value: 'C' }];

  const result = rebasePatch(base, patch, onto);
  assert.equal(result.status, 'clean');
  // b removed upstream; x,y inserted as a run; the client's edit to base
  // element 2 (c) followed the element to its new position.
  assert.deepEqual(result.merged, {
    list: [{ id: 'a' }, { id: 'x' }, { id: 'y' }, { id: 'C' }],
    mode: 'ha',
  });
  assert.deepEqual(result.rebasedPatch, [
    { op: 'remove', path: '/list/3' },
    { op: 'add', path: '/list/3', value: { id: 'C' } },
  ]);
  assert.deepEqual(applyPatch(onto, result.rebasedPatch), result.merged);
  assert.deepEqual(result.stats, {
    received: { onto: 3, patch: 1 },
    normalized: { onto: 3, patch: 1 },
    deduplicated: 0,
    conflicts: 0,
    applied: 4,
    rebased: 2,
  });
});

test('rebase with an empty patch yields onto and an empty rebased patch', () => {
  const { base, onto } = EXAMPLE_REBASE_REQUEST;
  const result = rebasePatch(base, [], onto);
  assert.equal(result.status, 'clean');
  assert.deepEqual(result.merged, onto);
  assert.deepEqual(result.rebasedPatch, []);
  assert.equal(result.stats.rebased, 0);
});

test('client changes already present in onto are deduplicated out of the rebase', () => {
  const result = rebasePatch({ r: 1 }, [{ op: 'replace', path: '/r', value: 2 }], { r: 2 });
  assert.equal(result.status, 'clean');
  assert.deepEqual(result.merged, { r: 2 });
  assert.deepEqual(result.rebasedPatch, []); // nothing left to re-apply
  assert.equal(result.stats.deduplicated, 1);
});

test('same-gap insertions land onto-first, client-second (git rebase order)', () => {
  const result = rebasePatch(
    { l: ['a', 'b'] },
    [{ op: 'add', path: '/l/-', value: 'mine' }],
    { l: ['a', 'b', 'up'] },
  );
  assert.equal(result.status, 'clean');
  assert.deepEqual(result.merged.l, ['a', 'b', 'up', 'mine']);
  assert.deepEqual(result.rebasedPatch, [{ op: 'add', path: '/l/3', value: 'mine' }]);
});

test('conflicting rebases report onto/patch sides and no executable patch', () => {
  const result = rebasePatch(
    { mode: 'ha', db: { host: 'x', port: 1 } },
    [
      { op: 'replace', path: '/mode', value: 'readonly' },
      { op: 'replace', path: '/db/host', value: 'y' },
    ],
    { mode: 'single' },
  );
  assert.equal(result.status, 'conflict');
  assert.equal(result.merged, null);
  assert.equal(result.rebasedPatch, null);
  assert.deepEqual(result.conflicts, [
    {
      reason: 'delete-vs-modify',
      path: '/db',
      operations: [
        { side: 'onto', index: 0, op: 'remove', path: '/db' },
        { side: 'patch', index: 1, op: 'replace', path: '/db/host', value: 'y' },
      ],
      message: 'one patch deletes this element while the other modifies it (onto#0 vs patch#1)',
    },
    {
      reason: 'replace-mismatch',
      path: '/mode',
      operations: [
        { side: 'onto', index: 1, op: 'replace', path: '/mode', value: 'single' },
        { side: 'patch', index: 0, op: 'replace', path: '/mode', value: 'readonly' },
      ],
      message: 'both patches replace the same target with different values (onto#1 vs patch#0)',
    },
  ]);
  assert.equal(result.stats.conflicts, 2);
  assert.equal(result.stats.rebased, 0);
});

/* ------------------------------ HTTP API --------------------------------- */

let app;

before(async () => {
  app = buildApp({ logger: false, storeMax: 100 });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('POST /api/v1/rebases with the example payload rebases cleanly (200)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: EXAMPLE_REBASE_REQUEST,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'clean');
  assert.deepEqual(body.merged, {
    app: 'payment-service',
    replicas: 3,
    servers: [
      { host: 'a.internal', port: 8080 },
      { host: 'canary.internal', port: 8080 },
      { host: 'b.internal', port: 8080 },
      { host: 'c.internal', port: 8080 },
    ],
    features: { cache: true, tracing: true, retries: 3 },
    version: '2.0.0',
  });
  // The client change re-expressed against onto; replaying it on onto
  // reproduces the merged document.
  assert.deepEqual(body.rebasedPatch, [
    { op: 'replace', path: '/features/tracing', value: true },
    { op: 'replace', path: '/replicas', value: 3 },
    { op: 'add', path: '/servers/1', value: { host: 'canary.internal', port: 8080 } },
  ]);
  assert.deepEqual(applyPatch(EXAMPLE_REBASE_REQUEST.onto, body.rebasedPatch), body.merged);
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.stats, {
    received: { onto: 3, patch: 3 },
    normalized: { onto: 3, patch: 3 },
    deduplicated: 0,
    conflicts: 0,
    applied: 6,
    rebased: 3,
  });
});

test('POST /api/v1/rebases conflict returns 409 without an executable patch', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: {
      base: { mode: 'ha' },
      patch: [{ op: 'replace', path: '/mode', value: 'readonly' }],
      onto: { mode: 'single' },
    },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.status, 'conflict');
  assert.equal(body.merged, null);
  assert.equal(body.rebasedPatch, null);
  assert.equal(body.conflicts.length, 1);
  const [conflict] = body.conflicts;
  assert.equal(conflict.reason, 'replace-mismatch');
  assert.equal(conflict.path, '/mode');
  assert.deepEqual(
    conflict.operations.map((o) => [o.side, o.index]),
    [
      ['onto', 0],
      ['patch', 0],
    ],
  );
});

test('POST /api/v1/rebases with a patch that does not apply to base returns 422', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: {
      base: { a: 1 },
      patch: [{ op: 'remove', path: '/nope' }],
      onto: { a: 1, b: 2 },
    },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'INVALID_PATCH');
  assert.equal(body.details.side, 'patch');
  assert.equal(body.details.index, 0);
  assert.match(body.message, /patch\[0\]/);
});

test('POST /api/v1/rebases rejects malformed bodies (400)', async () => {
  const bad = [
    { base: {}, patch: [] }, // missing onto
    { base: {}, patch: 'nope', onto: {} }, // patch not an array
    { base: {}, patch: [{ op: 'move', from: '/a', path: '/b' }], onto: {} }, // unsupported op
  ];
  for (const payload of bad) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/rebases', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test('POST /api/v1/rebases ignores unknown body fields like the merges endpoint', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: { base: {}, patch: [], onto: {}, extra: 1 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'clean');
});

test('POST /api/v1/rebases is deterministic across repeated requests', async () => {
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: EXAMPLE_REBASE_REQUEST,
  });
  const second = await app.inject({
    method: 'POST',
    url: '/api/v1/rebases',
    payload: EXAMPLE_REBASE_REQUEST,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, second.body);
});

test('GET / and /api/v1/example advertise the rebase endpoint', async () => {
  const root = await app.inject({ method: 'GET', url: '/' });
  assert.ok(root.json().endpoints['POST /api/v1/rebases']);

  const example = await app.inject({ method: 'GET', url: '/api/v1/example' });
  const { rebaseRequest } = example.json();
  assert.ok(rebaseRequest.base && rebaseRequest.patch && rebaseRequest.onto);
});

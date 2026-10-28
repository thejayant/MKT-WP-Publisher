'use strict';
// The SEO Bridge's block editor script (assets/editor-queue.js), run against a stand-in for the wp.* globals.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '../wordpress-plugin/mkt-wp-publisher-seo-bridge/assets/editor-queue.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
// Values made inside the script's context have that context's prototypes; compare them as plain data.
const plain = value => JSON.parse(JSON.stringify(value));

/** A minimal block editor: one post, notices, apiFetch answering from a queue list. */
function editor({dirty = false, modified = '2026-10-20T10:00:00', items = []} = {}) {
  const state = {dirty, modified, items, notices: new Map(), fetches: [], reset: null, listeners: [], postId: 0};
  const wp = {
    data: {
      select: store => ({
        'core/editor': {
          getCurrentPostId: () => state.postId,
          isEditedPostDirty: () => state.dirty,
          getCurrentPost: () => ({id: state.postId, modified_gmt: state.modified}),
        },
      }[store]),
      dispatch: store => ({
        'core/notices': {
          createNotice: (type, message, options) => state.notices.set(options.id, {type, message, options}),
          removeNotice: id => state.notices.delete(id),
        },
        'core/editor': {resetEditorBlocks: blocks => { state.reset = blocks; state.dirty = true; }, editPost: () => {}},
      }[store]),
      subscribe: listener => {
        state.listeners.push(listener);
        return () => { state.listeners = state.listeners.filter(l => l !== listener); };
      },
    },
    blocks: {parse: text => [{name: 'parsed', text}]},
    apiFetch: options => {
      state.fetches.push(options);
      if (options.method === 'POST') {
        const item = state.items.find(i => options.path.endsWith('/' + i.id));
        item.status = options.data.status;
        return Promise.resolve(item);
      }
      return Promise.resolve({version: '1.5.0', items: state.items.map(i => ({...i}))});
    },
  };
  const window = {wp, mktEditorQueue: {route: '/mkt-seo-bridge/v1/editor-queue/', interval: 15000}, setInterval: fn => {
    state.poll = fn;
    return 1;
  }};
  const document = {hidden: false, addEventListener: () => {}};
  vm.runInNewContext(code, {window, document});
  state.load = id => {
    state.postId = id;
    state.listeners.forEach(l => l());
  };
  state.button = (item, label) => state.notices.get('mkt-editor-queue-' + item).options.actions.find(a => a.label === label).onClick();
  return state;
}
const item = (over = {}) => ({id: 'aaaaaaaaaaaaaaaa', status: 'pending', label: 'County wording', base_modified_gmt: '2026-10-20T10:00:00', summary: [{before: 'a', after: 'b'}], content: '<p>new</p>', ...over});

test('editor script: waits for the post, then shows each pending change with Apply and Dismiss', async () => {
  const s = editor({items: [item(), item({id: 'bbbbbbbbbbbbbbbb', status: 'applied'})]});
  assert.equal(s.fetches.length, 0, 'nothing before the post is loaded');
  s.load(1941);
  await tick();
  assert.equal(s.fetches[0].path, '/mkt-seo-bridge/v1/editor-queue/1941?content=1');
  assert.equal(s.notices.size, 1, 'finished changes are not shown');
  const notice = s.notices.get('mkt-editor-queue-aaaaaaaaaaaaaaaa');
  assert.match(notice.message, /Claude prepared "County wording" \(1 edit\).*nothing is saved until you click Save or Update/);
  assert.deepEqual(plain(notice.options.actions.map(a => a.label)), ['Apply', 'Dismiss']);
  assert.equal(notice.options.isDismissible, false);
});

test('editor script: Apply replaces the editor blocks only, then marks the change applied', async () => {
  const s = editor({items: [item()]});
  s.load(1941);
  await tick();
  s.button('aaaaaaaaaaaaaaaa', 'Apply');
  await tick();
  assert.deepEqual(plain(s.reset), [{name: 'parsed', text: '<p>new</p>'}]);
  const post = s.fetches.find(f => f.method === 'POST');
  assert.equal(post.path, '/mkt-seo-bridge/v1/editor-queue/1941/aaaaaaaaaaaaaaaa');
  assert.deepEqual(plain(post.data), {status: 'applied'});
  assert(!s.notices.has('mkt-editor-queue-aaaaaaaaaaaaaaaa'));
  assert.match(s.notices.get('mkt-editor-queue-applied').message, /Save or Update to keep it/);
});

test('editor script: never applies over unsaved edits or to a newer version of the post', async () => {
  const dirty = editor({dirty: true, items: [item()]});
  dirty.load(1941);
  await tick();
  dirty.button('aaaaaaaaaaaaaaaa', 'Apply');
  assert.equal(dirty.reset, null);
  assert.match(dirty.notices.get('mkt-editor-queue-message').message, /Save or undo your own unsaved changes first/);
  assert(!dirty.fetches.some(f => f.method === 'POST'));

  const stale = editor({modified: '2026-10-21T08:00:00', items: [item()]});
  stale.load(1941);
  await tick();
  stale.button('aaaaaaaaaaaaaaaa', 'Apply');
  assert.equal(stale.reset, null);
  assert.match(stale.notices.get('mkt-editor-queue-message').message, /prepared for an earlier version/);
});

test('editor script: Dismiss marks the change dismissed; changes finished elsewhere disappear', async () => {
  const s = editor({items: [item(), item({id: 'cccccccccccccccc', label: ''})]});
  s.load(1941);
  await tick();
  assert.match(s.notices.get('mkt-editor-queue-cccccccccccccccc').message, /Claude prepared a change/);
  s.button('aaaaaaaaaaaaaaaa', 'Dismiss');
  await tick();
  assert.deepEqual(plain(s.fetches.find(f => f.method === 'POST').data), {status: 'dismissed'});
  assert(!s.notices.has('mkt-editor-queue-aaaaaaaaaaaaaaaa'));
  assert(s.notices.has('mkt-editor-queue-cccccccccccccccc'));
  s.items[1].status = 'dismissed'; // Cancelled by Claude with cancel_editor_change.
  s.poll(); // The next timed check.
  await tick();
  assert(!s.notices.has('mkt-editor-queue-cccccccccccccccc'), 'removed once it is no longer pending');
});

test('editor script: does nothing without the block editor globals', () => {
  for (const window of [{}, {wp: {}}, {wp: {data: {}}, mktEditorQueue: null}]) {
    assert.doesNotThrow(() => vm.runInNewContext(code, {window, document: {hidden: false, addEventListener() {}}}));
  }
});

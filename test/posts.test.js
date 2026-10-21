'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService, tools, VERSION} = require('../server/service.js');
const {sites, env, mock, runChild, slot, seoSchema, png} = require('./helpers.js');

test('draft creation strips routing fields and forces draft, rejecting injected status',async()=>{
 const m=mock([[],{id:1,status:'draft'}]);const call=makeService(env,m.f);
 const draft=await call('create_draft',{site_id:'site-b',title:'B',content:'<p>B</p>',slug:'same-slug',categories:[1],featured_media:3});assert.equal(draft.site_id,'site-b');
 assert.deepEqual(JSON.parse(m.calls[1].o.body),{title:'B',content:'<p>B</p>',slug:'same-slug',categories:[1],featured_media:3,status:'draft'});
 await assert.rejects(call('create_draft',{site_id:'site-b',title:'B',content:'B',slug:'b',status:'publish'}),/Unknown argument/);
});
test('publication requires confirmation; published/future posts are protected',async()=>{
 const m=mock([{id:1,status:'publish',title:{raw:'T'}},{id:1,status:'future',title:{raw:'T'}},{id:1,status:'publish',title:{raw:'T'}}]);const call=makeService(env,m.f);
 await assert.rejects(call('publish_post',{site_id:'site-a',post_id:1,confirm_title:'T',confirm_publish:false}),/must be true/);
 await assert.rejects(call('update_draft',{site_id:'site-a',post_id:1,title:'change'}),/this one is publish. To change a published post, use edit_published_post/);
 await assert.rejects(call('publish_post',{site_id:'site-a',post_id:1,confirm_title:'T',confirm_publish:true}),/draft or pending/);
 const result=await call('publish_post',{site_id:'site-a',post_id:1,confirm_title:'T',confirm_publish:true});assert.equal(result.data.status,'publish');assert(m.calls.every(c=>c.o.method==='GET'));
});
test('empty and invalid update content/slug rejected without requests',async()=>{
 const m=mock([]);for(const fields of [{title:''},{content:' '},{slug:'Bad slug'},{featured_media:-1}])await assert.rejects(makeService(env,m.f)('update_draft',{site_id:'site-a',post_id:1,...fields}));assert.equal(m.calls.length,0);
});
test('publish_post checks the title, refuses future-dated drafts and warns on an unexpected status',async()=>{
 const m=mock([{id:3,status:'draft',title:{raw:'Real title'}},{id:3,status:'draft',title:{raw:'Real title'},date_gmt:'2999-01-01T09:00:00'},{id:3,status:'draft',title:{raw:'Real  title '},date_gmt:'2020-01-01T09:00:00'},{id:3,status:'pending',title:{raw:'Real title'}}]);const call=makeService(env,m.f);
 await assert.rejects(call('publish_post',{site_id:'site-a',post_id:3,confirm_title:'Other title',confirm_publish:true}),/does not match/);
 await assert.rejects(call('publish_post',{site_id:'site-a',post_id:3,confirm_title:'Real title',confirm_publish:true}),/future date/);
 assert(m.calls.every(c=>c.o.method==='GET'));
 const r=await call('publish_post',{site_id:'site-a',post_id:3,confirm_title:'Real title',confirm_publish:true});assert.equal(m.calls[3].o.method,'POST');assert.equal(r.data.status,'pending');assert.match(r.data.warning,/not publish/);
 await assert.rejects(makeService(env,mock([]).f)('publish_post',{site_id:'site-a',post_id:3,confirm_publish:true}),/Missing confirm_title/);
});
test('B4: update_draft with no fields is rejected without requests',async()=>{
 const m=mock([]);await assert.rejects(makeService(env,m.f)('update_draft',{site_id:'site-a',post_id:1}),/at least one field/);assert.equal(m.calls.length,0);
});
test('F2: list_posts defaults to drafts/pending, supports all and search, returns compact items',async()=>{
 const m=mock([[{id:4,status:'draft',title:{raw:'Spring',rendered:'Spring'},slug:'spring',link:'https://a.example/?p=4',author:2,modified_gmt:'2026-10-19T10:00:00'}],[{id:5,status:'publish',title:{raw:'Live'},slug:'live',link:'https://a.example/live'}]]);const call=makeService(env,m.f);
 const r=await call('list_posts',{site_id:'site-a',search:'spring & co'});
 assert.match(m.calls[0].u,/^https:\/\/a\.example\/wp-json\/wp\/v2\/posts\?context=edit&per_page=50&page=1&status=draft,pending&orderby=modified&order=desc&search=spring%20%26%20co&_fields=/);
 assert.deepEqual(r.data.items[0],{post_id:4,status:'draft',title:'Spring',slug:'spring',url:'https://a.example/?p=4',author:2,modified_gmt:'2026-10-19T10:00:00',preview_url:'https://a.example/?p=4&preview=true'});assert.equal(r.data.has_more,false);
 const all=await call('list_posts',{site_id:'site-a',status:'all',page:2});assert.match(m.calls[1].u,/status=draft,pending,future,publish,private/);assert.match(m.calls[1].u,/page=2/);assert(!('preview_url' in all.data.items[0]));
 await assert.rejects(call('list_posts',{site_id:'site-a',status:'trash'}),/must be one of/);assert.equal(m.calls.length,2);
});
test('F5: get_post and term lists are compact by default, full on request',async()=>{
 const post={id:7,status:'draft',link:'https://a.example/?p=7',slug:'s',title:{raw:'Raw T',rendered:'Raw T'},content:{raw:'<p>c</p>',rendered:'<p>c</p>\n',block_version:0},excerpt:{raw:'e',rendered:'<p>e</p>'},author:1,featured_media:0,categories:[1],tags:[2],date_gmt:null,modified_gmt:'2026-10-20T00:00:00',_links:{self:[]},meta:{}};
 const m=mock([post,post,[{id:1,name:'A &amp; B',slug:'a-b',count:3,parent:0,description:'d',_links:{}}],[{id:1,name:'A',_links:{}}]]);const call=makeService(env,m.f);
 const lean=await call('get_post',{site_id:'site-a',post_id:7});
 assert.deepEqual(lean.data,{post_id:7,status:'draft',url:'https://a.example/?p=7',slug:'s',title:'Raw T',author:1,featured_media:0,categories:[1],preview_url:'https://a.example/?p=7&preview=true',excerpt:'e',content:'<p>c</p>',tags:[2],date_gmt:null,modified_gmt:'2026-10-20T00:00:00'});
 assert.deepEqual((await call('get_post',{site_id:'site-a',post_id:7,full:true})).data,post);
 assert.deepEqual((await call('list_categories',{site_id:'site-a'})).data.items,[{id:1,name:'A & B',slug:'a-b',count:3,parent:0}]);
 assert.deepEqual((await call('list_tags',{site_id:'site-a',full:true})).data.items,[{id:1,name:'A',_links:{}}]);
});
test('F11: draft summaries include a preview link; published ones do not',async()=>{
 const m=mock([[],{id:21,status:'draft',link:'https://b.example/blog/?p=21'},{id:21,status:'draft',title:{raw:'T'}},{id:21,status:'publish',title:{raw:'T'}}]);const call=makeService(env,m.f);
 assert.equal((await call('create_draft',{site_id:'site-b',title:'T',content:'C',slug:'t'})).data.preview_url,'https://b.example/blog/?p=21&preview=true');
 assert(!('preview_url' in (await call('publish_post',{site_id:'site-b',post_id:21,confirm_title:'T',confirm_publish:true})).data));
});
test('F3: SEO fields are checked via OPTIONS, sent as mkt_seo and reported back',async()=>{
 const seo={title:'Spring Recap | MKT',description:'What we learned.',focus_keyword:'spring campaign'};
 const m=mock([seoSchema('yoast'),[],{id:30,status:'draft',mkt_seo:{plugin:'yoast',...seo}},{id:30,status:'draft'},{id:30,status:'draft'}]);const call=makeService(env,m.f);
 const d=await call('create_draft',{site_id:'site-a',title:'T',content:'C',slug:'t',seo});
 assert.equal(m.calls[0].o.method,'OPTIONS');assert.equal(m.calls[0].u,'https://a.example/wp-json/wp/v2/posts');
 assert.deepEqual(JSON.parse(m.calls[2].o.body),{title:'T',content:'C',slug:'t',mkt_seo:seo,status:'draft'});assert.deepEqual(d.data.seo,{plugin:'yoast',...seo});
 // The OPTIONS result is cached per site; a response without mkt_seo produces a warning.
 const u=await call('update_draft',{site_id:'site-a',post_id:30,seo:{description:''}});assert.equal(m.calls.length,5);assert.deepEqual(JSON.parse(m.calls[4].o.body),{mkt_seo:{description:''}});assert.match(u.data.warning,/did not confirm the SEO fields/);
 await assert.rejects(call('update_draft',{site_id:'site-a',post_id:30,seo:{}}),/at least one of: title, description, focus_keyword/);
 await assert.rejects(call('update_draft',{site_id:'site-a',post_id:30,seo:{robots:'noindex'}}),/Unknown seo field/);
 await assert.rejects(call('update_draft',{site_id:'site-a',post_id:30,seo:{title:5}}),/seo.title must be text/);
 const none=mock([{schema:{properties:{}}}]);await assert.rejects(makeService(env,none.f)('create_draft',{site_id:'site-b',title:'T',content:'C',slug:'t',seo}),/SEO Bridge plugin on site site-b.*Nothing was saved/);assert.equal(none.calls.length,1);
 const off=mock([seoSchema('none')]);await assert.rejects(makeService(env,off.f)('update_draft',{site_id:'site-b',post_id:1,seo}),/neither Yoast SEO nor Rank Math/);assert.equal(off.calls.length,1);
});
test('F6: schedule_post validates title, time and status, then sets future with date_gmt',async()=>{
 const at=new Date(Date.now()+3*86400000);at.setUTCSeconds(0,0);const iso=at.toISOString().replace('.000Z','+00:00');
 const m=mock([{id:40,status:'draft',title:{raw:'Launch'}},{id:40,status:'future',link:'https://a.example/?p=40'},{id:40,status:'publish',title:{raw:'Launch'}},{id:40,status:'draft',title:{raw:'Launch'}},{id:40,status:'pending'}]);const call=makeService(env,m.f);
 const r=await call('schedule_post',{site_id:'site-a',post_id:40,publish_at:iso,confirm_title:'Launch',confirm_schedule:true});
 assert.deepEqual(JSON.parse(m.calls[1].o.body),{status:'future',date_gmt:at.toISOString().slice(0,19)});assert.equal(r.data.status,'future');assert.equal(r.data.publish_at_gmt,at.toISOString().slice(0,19)+'Z');assert(!r.data.warning);
 await assert.rejects(call('schedule_post',{site_id:'site-a',post_id:40,publish_at:iso,confirm_title:'Launch',confirm_schedule:true}),/this one is publish/);
 const w=await call('schedule_post',{site_id:'site-a',post_id:40,publish_at:iso,confirm_title:'Launch',confirm_schedule:true});assert.match(w.data.warning,/not future/);
 const bad=mock(Array.from({length:6},()=>({id:41,status:'draft',title:{raw:'Launch'}})));const call2=makeService(env,bad.f);
 for(const [publish_at,re] of [['2026-11-02 09:00','ISO 8601'],['2026-11-02T09:00:00','ISO 8601'],[new Date(Date.now()+60000).toISOString(),'2 minutes'],[new Date(Date.now()+3*366*86400000).toISOString(),'2 years']])await assert.rejects(call2('schedule_post',{site_id:'site-a',post_id:41,publish_at,confirm_title:'Launch',confirm_schedule:true}),new RegExp(re));
 await assert.rejects(call2('schedule_post',{site_id:'site-a',post_id:41,publish_at:iso,confirm_title:'Other',confirm_schedule:true}),/does not match/);
 assert(bad.calls.every(c=>c.o.method==='GET'));
 await assert.rejects(call2('schedule_post',{site_id:'site-a',post_id:41,publish_at:iso,confirm_title:'Launch',confirm_schedule:false}),/must be true/);
 const future=mock([{id:3,status:'draft',title:{raw:'T'},date_gmt:'2999-01-01T09:00:00'}]);await assert.rejects(makeService(env,future.f)('publish_post',{site_id:'site-a',post_id:3,confirm_title:'T',confirm_publish:true}),/Use schedule_post/);
});
test('F7: pages use /pages, page preview links and parent; post-only fields are rejected',async()=>{
 const m=mock([[],{id:50,type:'page',status:'draft',parent:7,link:'https://b.example/blog/?page_id=50'},{id:50,type:'page',status:'draft',title:{raw:'About'},content:{raw:'<p>x</p>'},parent:7},[{id:50,type:'page',status:'draft',title:{raw:'About'}}],{id:50,type:'page',status:'draft',title:{raw:'About'}},{id:50,type:'page',status:'publish',title:{raw:'About'}}]);const call=makeService(env,m.f);
 const d=await call('create_draft',{site_id:'site-b',post_type:'page',title:'About',content:'<p>x</p>',slug:'about',parent:7});
 assert.match(m.calls[0].u,/\/wp\/v2\/pages\?context=edit&slug=about/);assert.equal(m.calls[1].u,'https://b.example/blog/wp-json/wp/v2/pages');assert.deepEqual(JSON.parse(m.calls[1].o.body),{title:'About',content:'<p>x</p>',slug:'about',parent:7,status:'draft'});
 assert.equal(d.data.post_type,'page');assert.equal(d.data.parent,7);assert(!('categories' in d.data));assert.equal(d.data.preview_url,'https://b.example/blog/?page_id=50&preview=true');
 const g=await call('get_post',{site_id:'site-b',post_type:'page',post_id:50});assert.match(m.calls[2].u,/\/pages\/50\?context=edit$/);assert.equal(g.data.title,'About');assert(!('excerpt' in g.data)&&!('tags' in g.data));
 const l=await call('list_posts',{site_id:'site-b',post_type:'page'});assert.match(m.calls[3].u,/\/wp\/v2\/pages\?context=edit/);assert.equal(l.data.items[0].post_type,'page');
 await call('publish_post',{site_id:'site-b',post_type:'page',post_id:50,confirm_title:'About',confirm_publish:true});assert(m.calls.slice(4).every(c=>c.u.includes('/wp/v2/pages/50')));
 for(const extra of [{categories:[1]},{tags:[2]},{excerpt:'e'}])await assert.rejects(call('create_draft',{site_id:'site-b',post_type:'page',title:'A',content:'C',slug:'a',...extra}),/posts only/);
 await assert.rejects(call('create_draft',{site_id:'site-b',title:'A',content:'C',slug:'a',parent:3}),/pages only/);
 await assert.rejects(call('get_post',{site_id:'site-b',post_type:'Product!',post_id:1}),/must be a post type slug/);assert.equal(m.calls.length,6);
});
test('F12: content_format markdown is converted before sending; html is untouched',async()=>{
 const m=mock([[],{id:60,status:'draft'},{id:60,status:'draft'},{id:60,status:'draft'}]);const call=makeService(env,m.f);
 await call('create_draft',{site_id:'site-a',title:'T',slug:'t',content_format:'markdown',content:'## Hello\n\nSome **bold** text.'});
 assert.equal(JSON.parse(m.calls[1].o.body).content,'<h2>Hello</h2>\n<p>Some <strong>bold</strong> text.</p>');assert(!('content_format' in JSON.parse(m.calls[1].o.body)));
 await call('update_draft',{site_id:'site-a',post_id:60,content_format:'html',content:'**raw**'});assert.equal(JSON.parse(m.calls[3].o.body).content,'**raw**');
 await assert.rejects(call('update_draft',{site_id:'site-a',post_id:60,content_format:'markdown'}),/content_format needs content/);
});

test('B9: update_draft checks a new slug against other posts and warns if WordPress changes it', async () => {
  const draft = {id: 8, status: 'draft', slug: 'old-slug', title: {raw: 'T'}};

  const taken = mock([draft, [{id: 12, slug: 'taken'}]]);
  await assert.rejects(makeService(env, taken.f)('update_draft', {site_id: 'site-a', post_id: 8, slug: 'taken'}), /Slug already exists on site site-a at post ID 12\. Choose another slug/);
  assert(taken.calls.every(c => c.o.method === 'GET'));
  assert.match(taken.calls[1].u, /\/posts\?context=edit&slug=taken&status=/);

  const same = mock([draft, {...draft}]);
  await makeService(env, same.f)('update_draft', {site_id: 'site-a', post_id: 8, slug: 'old-slug', title: 'New'});
  assert.equal(same.calls.length, 2, 'unchanged slug needs no lookup');

  const renamed = mock([draft, [{id: 8, slug: 'fresh'}], {...draft, slug: 'fresh-2'}]);
  const r = await makeService(env, renamed.f)('update_draft', {site_id: 'site-a', post_id: 8, slug: 'fresh'});
  assert.match(r.data.warning, /saved the slug as fresh-2 instead of fresh/);
});

test('F13: expected_modified_gmt refuses writes when the post changed since it was read', async () => {
  const current = {id: 5, status: 'draft', title: {raw: 'T'}, modified_gmt: '2026-10-20T10:00:00'};
  const changed = mock([current]);
  await assert.rejects(
    makeService(env, changed.f)('update_draft', {site_id: 'site-a', post_id: 5, title: 'X', expected_modified_gmt: '2026-10-20T09:59:00'}),
    /changed since you read it \(modified_gmt is now 2026-10-20T10:00:00\).*nothing was written/,
  );
  assert.equal(changed.calls.length, 1);

  for (const stamp of ['2026-10-20T10:00:00', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00+00:00']) {
    const m = mock([current, {...current, status: 'publish'}]);
    const r = await makeService(env, m.f)('publish_post', {site_id: 'site-a', post_id: 5, confirm_title: 'T', confirm_publish: true, expected_modified_gmt: stamp});
    assert.equal(r.data.status, 'publish');
  }

  const sched = mock([current]);
  await assert.rejects(
    makeService(env, sched.f)('schedule_post', {site_id: 'site-a', post_id: 5, publish_at: new Date(Date.now() + 86400000).toISOString(), confirm_title: 'T', confirm_schedule: true, expected_modified_gmt: '2026-01-01T00:00:00'}),
    /changed since you read it/,
  );
  assert.equal(sched.calls.length, 1);
});

test('1.5: update_draft edits scheduled posts and keeps them scheduled', async () => {
  const scheduled = {id: 70, status: 'future', title: {raw: 'Launch'}, slug: 'launch', date_gmt: '2099-01-01T09:00:00'};
  const m = mock([scheduled, {...scheduled, title: {raw: 'Launch v2'}}]);
  const r = await makeService(env, m.f)('update_draft', {site_id: 'site-a', post_id: 70, title: 'Launch v2', featured_media: 12});
  assert.deepEqual(JSON.parse(m.calls[1].o.body), {title: 'Launch v2', featured_media: 12}, 'no status or date is sent');
  assert.equal(r.data.status, 'future');
  assert(!r.data.warning);

  const flipped = mock([scheduled, {...scheduled, status: 'draft'}]);
  const w = await makeService(env, flipped.f)('update_draft', {site_id: 'site-a', post_id: 70, title: 'X'});
  assert.match(w.data.warning, /status changed from future to draft/);
});

test('1.5: edit_published_post changes live posts only with the current title confirmed', async () => {
  const live = {id: 80, status: 'publish', title: {raw: 'Live title'}, slug: 'live-title', link: 'https://a.example/live-title'};
  const seo = {title: 'New SEO title', description: 'New meta description'};
  const m = mock([seoSchema('yoast'), live, {...live, title: {raw: 'Better title'}, featured_media: 44, mkt_seo: {plugin: 'yoast', ...seo, focus_keyword: ''}}]);
  const r = await makeService(env, m.f)('edit_published_post', {site_id: 'site-a', post_id: 80, title: 'Better title', featured_media: 44, seo, confirm_title: 'Live title', confirm_edit: true});
  assert.deepEqual(JSON.parse(m.calls[2].o.body), {title: 'Better title', featured_media: 44, mkt_seo: seo});
  assert.equal(r.data.seo.title, 'New SEO title');
  assert(!('preview_url' in r.data));

  const wrongTitle = mock([live]);
  await assert.rejects(makeService(env, wrongTitle.f)('edit_published_post', {site_id: 'site-a', post_id: 80, title: 'X', confirm_title: 'Better title', confirm_edit: true}), /does not match the current title/);
  assert(wrongTitle.calls.every(c => c.o.method === 'GET'));

  const draft = mock([{...live, status: 'draft'}]);
  await assert.rejects(makeService(env, draft.f)('edit_published_post', {site_id: 'site-a', post_id: 80, title: 'X', confirm_title: 'Live title', confirm_edit: true}), /publish\/private posts only; this one is draft\. Use update_draft/);

  await assert.rejects(makeService(env, mock([]).f)('edit_published_post', {site_id: 'site-a', post_id: 80, title: 'X', confirm_title: 'Live title', confirm_edit: false}), /must be true/);
  await assert.rejects(makeService(env, mock([]).f)('edit_published_post', {site_id: 'site-a', post_id: 80, confirm_title: 'Live title', confirm_edit: true}), /needs at least one field/);

  const renamed = mock([live, [], {...live, slug: 'new-url'}]);
  const s = await makeService(env, renamed.f)('edit_published_post', {site_id: 'site-a', post_id: 80, slug: 'new-url', confirm_title: 'Live title', confirm_edit: true});
  assert.match(s.data.warning, /public URL changed/);

  const backdated = mock([live, {...live}]);
  await makeService(env, backdated.f)('edit_published_post', {site_id: 'site-a', post_id: 80, publish_date: '2024-05-01T10:00:00+05:30', confirm_title: 'Live title', confirm_edit: true});
  assert.deepEqual(JSON.parse(backdated.calls[1].o.body), {date_gmt: '2024-05-01T04:30:00'});
});

test('1.5: publish_post can back-date, and publish now a draft that has a future date', async () => {
  const draft = {id: 90, status: 'draft', title: {raw: 'Old news'}, date_gmt: null};
  const m = mock([draft, {...draft, status: 'publish'}]);
  const r = await makeService(env, m.f)('publish_post', {site_id: 'site-a', post_id: 90, publish_date: '2025-03-01T10:00:00+05:30', confirm_title: 'Old news', confirm_publish: true});
  assert.deepEqual(JSON.parse(m.calls[1].o.body), {status: 'publish', date_gmt: '2025-03-01T04:30:00'});
  assert.equal(r.data.published_at_gmt, '2025-03-01T04:30:00Z');

  const futureDated = {...draft, date_gmt: '2099-01-01T00:00:00'};
  const now = new Date().toISOString();
  const f = mock([futureDated, {...futureDated, status: 'publish'}]);
  await makeService(env, f.f)('publish_post', {site_id: 'site-a', post_id: 90, publish_date: now, confirm_title: 'Old news', confirm_publish: true});
  assert.equal(JSON.parse(f.calls[1].o.body).status, 'publish');

  for (const [publish_date, re] of [[new Date(Date.now() + 3600000).toISOString(), /now or in the past\. To publish later, use schedule_post/], ['2025-03-01 10:00', /ISO 8601/], ['1980-01-01T00:00:00Z', /too far in the past/]]) {
    const bad = mock([draft]);
    await assert.rejects(makeService(env, bad.f)('publish_post', {site_id: 'site-a', post_id: 90, publish_date, confirm_title: 'Old news', confirm_publish: true}), re);
    assert(bad.calls.every(c => c.o.method === 'GET'));
  }
  const already = mock([{...draft, status: 'publish'}]);
  await assert.rejects(makeService(env, already.f)('publish_post', {site_id: 'site-a', post_id: 90, publish_date: now, confirm_title: 'Old news', confirm_publish: true}), /already published\. To change its date, use edit_published_post/);
});

test('1.5: unpublish_post moves published or scheduled posts back to draft', async () => {
  const live = {id: 95, status: 'publish', title: {raw: 'Gone soon'}};
  const m = mock([live, {...live, status: 'draft'}]);
  const r = await makeService(env, m.f)('unpublish_post', {site_id: 'site-b', post_id: 95, confirm_title: 'Gone soon', confirm_unpublish: true});
  assert.deepEqual(JSON.parse(m.calls[1].o.body), {status: 'draft'});
  assert.equal(r.data.status, 'draft');
  assert.equal(r.data.previous_status, 'publish');
  assert(!r.data.warning);

  const scheduled = mock([{...live, status: 'future'}, {...live, status: 'draft'}]);
  const u = await makeService(env, scheduled.f)('unpublish_post', {site_id: 'site-b', post_id: 95, confirm_title: 'Gone soon', confirm_unpublish: true});
  assert.match(u.data.warning, /keeps its future date/);

  const page = mock([{...live, type: 'page'}, {...live, type: 'page', status: 'draft'}]);
  await makeService(env, page.f)('unpublish_post', {site_id: 'site-b', post_type: 'page', post_id: 95, confirm_title: 'Gone soon', confirm_unpublish: true});
  assert(page.calls.every(c => c.u.includes('/wp/v2/pages/95')));

  const already = mock([{...live, status: 'draft'}]);
  await makeService(env, already.f)('unpublish_post', {site_id: 'site-b', post_id: 95, confirm_title: 'Gone soon', confirm_unpublish: true});
  assert.equal(already.calls.length, 1, 'already a draft: nothing written');

  const wrong = mock([live]);
  await assert.rejects(makeService(env, wrong.f)('unpublish_post', {site_id: 'site-b', post_id: 95, confirm_title: 'Other', confirm_unpublish: true}), /does not match/);
  assert.equal(wrong.calls.length, 1);
});

test('SEO Bridge 1.1: canonical is sent when the bridge supports it, refused (before writing) on bridge 1.0', async () => {
  const bridge11 = {schema: {properties: {mkt_seo: {properties: {plugin: {enum: ['yoast']}, version: {enum: ['1.1.0']}, title: {}, description: {}, focus_keyword: {}, canonical: {}}}}}};
  const live = {id: 81, status: 'publish', title: {raw: 'Moved article'}};
  const m = mock([bridge11, live, {...live, mkt_seo: {plugin: 'yoast', version: '1.1.0', canonical: 'https://old.example/article'}}]);
  const r = await makeService(env, m.f)('edit_published_post', {site_id: 'site-a', post_id: 81, seo: {canonical: 'https://old.example/article'}, confirm_title: 'Moved article', confirm_edit: true});
  assert.deepEqual(JSON.parse(m.calls[2].o.body), {mkt_seo: {canonical: 'https://old.example/article'}});
  assert.equal(r.data.seo.canonical, 'https://old.example/article');

  const old = mock([seoSchema('yoast')]);
  await assert.rejects(
    makeService(env, old.f)('update_draft', {site_id: 'site-a', post_id: 81, seo: {title: 'T', canonical: 'https://x.example/'}}),
    /SEO Bridge plugin on site site-a \(version 1\.0\.0\) does not support canonical\. Update it to version 1\.1\.0.*Nothing was saved/,
  );
  assert.equal(old.calls.length, 1, 'only the OPTIONS check ran');

  const base = mock([seoSchema('rank-math'), {id: 5, status: 'draft'}, {id: 5, status: 'draft', mkt_seo: {plugin: 'rank-math'}}]);
  await makeService(env, base.f)('update_draft', {site_id: 'site-a', post_id: 5, seo: {title: 'T', description: 'D', focus_keyword: 'k'}});
  assert.equal(base.calls.length, 3, 'bridge 1.0 still handles the original three fields');

  for (const canonical of ['ftp://x.example/', 'javascript:alert(1)', '/relative/path', 'https://has space.example']) {
    const bad = mock([]);
    await assert.rejects(makeService(env, bad.f)('update_draft', {site_id: 'site-a', post_id: 5, seo: {canonical}}), /seo\.canonical must be a full http/);
    assert.equal(bad.calls.length, 0);
  }
  const clear = mock([bridge11, {id: 5, status: 'draft'}, {id: 5, status: 'draft', mkt_seo: {plugin: 'yoast', canonical: ''}}]);
  await makeService(env, clear.f)('update_draft', {site_id: 'site-a', post_id: 5, seo: {canonical: ''}});
  assert.deepEqual(JSON.parse(clear.calls[2].o.body), {mkt_seo: {canonical: ''}});
});

'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService, tools, VERSION} = require('../server/service.js');
const {sites, env, mock, runChild, slot, seoSchema} = require('./helpers.js');

test('draft creation strips routing fields and forces draft, rejecting injected status',async()=>{
 const m=mock([[],{id:1,status:'draft'}]);const call=makeService(env,m.f);
 const draft=await call('create_draft',{site_id:'site-b',title:'B',content:'<p>B</p>',slug:'same-slug',categories:[1],featured_media:3});assert.equal(draft.site_id,'site-b');
 assert.deepEqual(JSON.parse(m.calls[1].o.body),{title:'B',content:'<p>B</p>',slug:'same-slug',categories:[1],featured_media:3,status:'draft'});
 await assert.rejects(call('create_draft',{site_id:'site-b',title:'B',content:'B',slug:'b',status:'publish'}),/Unknown argument/);
});
test('publication requires confirmation; published/future posts are protected',async()=>{
 const m=mock([{id:1,status:'publish',title:{raw:'T'}},{id:1,status:'future',title:{raw:'T'}},{id:1,status:'publish',title:{raw:'T'}}]);const call=makeService(env,m.f);
 await assert.rejects(call('publish_post',{site_id:'site-a',post_id:1,confirm_title:'T',confirm_publish:false}),/must be true/);
 await assert.rejects(call('update_draft',{site_id:'site-a',post_id:1,title:'change'}),/draft or pending/);
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
 await assert.rejects(call('get_post',{site_id:'site-b',post_type:'product',post_id:1}),/must be one of: post, page/);assert.equal(m.calls.length,6);
});
test('F12: content_format markdown is converted before sending; html is untouched',async()=>{
 const m=mock([[],{id:60,status:'draft'},{id:60,status:'draft'},{id:60,status:'draft'}]);const call=makeService(env,m.f);
 await call('create_draft',{site_id:'site-a',title:'T',slug:'t',content_format:'markdown',content:'## Hello\n\nSome **bold** text.'});
 assert.equal(JSON.parse(m.calls[1].o.body).content,'<h2>Hello</h2>\n<p>Some <strong>bold</strong> text.</p>');assert(!('content_format' in JSON.parse(m.calls[1].o.body)));
 await call('update_draft',{site_id:'site-a',post_id:60,content_format:'html',content:'**raw**'});assert.equal(JSON.parse(m.calls[3].o.body).content,'**raw**');
 await assert.rejects(call('update_draft',{site_id:'site-a',post_id:60,content_format:'markdown'}),/content_format needs content/);
});

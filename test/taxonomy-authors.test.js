'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService, tools, VERSION} = require('../server/service.js');
const {sites, env, mock, runChild, slot, seoSchema, png} = require('./helpers.js');

test('list_tags and list_categories report paging from WordPress headers',async()=>{
 const calls=[];const headers=h=>({get:k=>h[k]});
 const f=async(u,o)=>{calls.push(u);return u.includes('/tags')?{ok:true,headers:headers({'X-WP-Total':'150','X-WP-TotalPages':'2'}),json:async()=>[{id:7,name:'seo'}]}:{ok:true,json:async()=>Array.from({length:100},(_,i)=>({id:i+1}))};};
 const call=makeService(env,f);
 const tags=await call('list_tags',{site_id:'site-b',search:'seo'});assert.equal(calls[0],'https://b.example/blog/wp-json/wp/v2/tags?per_page=100&page=1&search=seo');assert.deepEqual({...tags.data,items:undefined},{items:undefined,page:1,total:150,total_pages:2,has_more:true});assert.equal(tags.data.items[0].id,7);
 const last=await call('list_tags',{site_id:'site-b',page:2});assert.equal(last.data.has_more,false);
 const cats=await call('list_categories',{site_id:'site-a'});assert.equal(cats.data.items.length,100);assert.equal(cats.data.has_more,true);assert(!('total_pages' in cats.data));
});
test('list_authors returns only author_id, name and slug, falling back to who=authors for Editors',async()=>{
 const people=[{id:4,name:'Priya Sharma',slug:'priya',email:'priya@example.com',roles:['author'],capabilities:{}},{id:9,name:'Rahul Mehta',slug:'rahul',email:'rahul@example.com'}];
 const admin=mock([people]);const r=await makeService(env,admin.f)('list_authors',{site_id:'site-a',search:'r'});
 assert.match(admin.calls[0].u,/^https:\/\/a\.example\/wp-json\/wp\/v2\/users\?context=edit&capabilities=edit_posts&per_page=100&page=1&search=r&orderby=name$/);
 assert.deepEqual(r.data.items,[{author_id:4,name:'Priya Sharma',slug:'priya'},{author_id:9,name:'Rahul Mehta',slug:'rahul'}]);assert(!JSON.stringify(r).includes('example.com'));assert.equal(r.data.has_more,false);
 const calls=[];const f=async(u)=>{calls.push(u);return u.includes('capabilities=')?{ok:false,status:403,json:async()=>({code:'rest_forbidden_context'})}:{ok:true,json:async()=>[people[1]]};};
 const e=await makeService(env,f)('list_authors',{site_id:'site-b'});assert.equal(calls.length,2);assert.match(calls[1],/\/users\?who=authors&per_page=100/);assert.deepEqual(e.data.items,[{author_id:9,name:'Rahul Mehta',slug:'rahul'}]);
});
test('create_draft and update_draft pass the chosen author and report it',async()=>{
 const m=mock([[],{id:20,status:'draft',author:9},{id:20,status:'draft'},{id:20,status:'draft',author:4}]);const call=makeService(env,m.f);
 const d=await call('create_draft',{site_id:'site-a',title:'T',content:'C',slug:'t',author:9});assert.equal(JSON.parse(m.calls[1].o.body).author,9);assert.equal(d.data.author,9);
 const u=await call('update_draft',{site_id:'site-a',post_id:20,author:4});assert.deepEqual(JSON.parse(m.calls[3].o.body),{author:4});assert.equal(u.data.author,4);
 await assert.rejects(call('create_draft',{site_id:'site-a',title:'T',content:'C',slug:'t2',author:0}),/integer >= 1/);
});
test('author permission and unknown-author errors explain what to do',async()=>{
 const deny=async(u,o)=>o.method==='POST'?{ok:false,status:403,json:async()=>({code:'rest_cannot_edit_others'})}:{ok:true,json:async()=>[]};
 await assert.rejects(makeService(env,deny)('create_draft',{site_id:'site-a',title:'T',content:'C',slug:'t',author:9}),/Editor or Administrator/);
 const bad=async(u,o)=>o.method==='POST'?{ok:false,status:400,json:async()=>({code:'rest_invalid_author'})}:{ok:true,json:async()=>[]};
 await assert.rejects(makeService(env,bad)('create_draft',{site_id:'site-a',title:'T',content:'C',slug:'t',author:999}),/list_authors/);
 const me=await makeService(env,mock([{id:1,capabilities:{edit_others_posts:true}}]).f)('test_connection',{site_id:'site-a'});assert.equal(me.data.permissions.edit_others_posts,true);
});
test('B7: list_authors falls back only on 400/403 rest_* permission errors',async()=>{
 for(const [status,code] of [[401,'rest_not_logged_in'],[500,'internal_server_error'],[403,'waf_block']]) {
  const calls=[];const f=async(u)=>{calls.push(u);return {ok:false,status,json:async()=>({code})};};
  await assert.rejects(makeService(env,f)('list_authors',{site_id:'site-a'}),new RegExp('HTTP '+status));assert.equal(calls.length,1);
 }
 const calls=[];const timeout=async(u)=>{calls.push(u);throw new Error('timeout');};
 await assert.rejects(makeService(env,timeout)('list_authors',{site_id:'site-a'}),/Network request failed/);assert.equal(calls.length,1);
 const editor=[];const f=async(u)=>{editor.push(u);return u.includes('capabilities=')?{ok:false,status:400,json:async()=>({code:'rest_invalid_param'})}:{ok:true,json:async()=>[]};};
 await makeService(env,f)('list_authors',{site_id:'site-a'});assert.equal(editor.length,2);
});
test('F4: create_term reuses an existing name or slug and otherwise creates once',async()=>{
 const m=mock([[{id:3,name:'News &amp; Events',slug:'news-events',parent:0}],[],{id:9,name:'SEO',slug:'seo'},[],{id:11,name:'Guides',slug:'guides',parent:3}]);const call=makeService(env,m.f);
 const hit=await call('create_term',{site_id:'site-b',taxonomy:'category',name:'news & events'});assert.deepEqual(hit.data,{term_id:3,taxonomy:'category',name:'News & Events',slug:'news-events',parent:0,existing:true});assert.equal(m.calls.length,1);assert.match(m.calls[0].u,/^https:\/\/b\.example\/blog\/wp-json\/wp\/v2\/categories\?per_page=100&search=news%20%26%20events$/);
 const tag=await call('create_term',{site_id:'site-b',taxonomy:'tag',name:' SEO '});assert.equal(tag.data.existing,false);assert.equal(m.calls[2].u,'https://b.example/blog/wp-json/wp/v2/tags');assert.deepEqual(JSON.parse(m.calls[2].o.body),{name:'SEO'});
 await call('create_term',{site_id:'site-b',taxonomy:'category',name:'Guides',slug:'guides',parent:3,description:'How-tos'});assert.deepEqual(JSON.parse(m.calls[4].o.body),{name:'Guides',slug:'guides',description:'How-tos',parent:3});
 await assert.rejects(call('create_term',{site_id:'site-b',taxonomy:'tag',name:'X',parent:3}),/categories only/);
 await assert.rejects(call('create_term',{site_id:'site-b',taxonomy:'category',name:'  '}),/name cannot be blank/);
 await assert.rejects(call('create_term',{site_id:'site-b',taxonomy:'category',name:'X',slug:'Bad Slug'}),/slug/);
 await assert.rejects(call('create_term',{site_id:'site-b',taxonomy:'page',name:'X'}),/must be one of/);assert.equal(m.calls.length,5);
 const exists=async(u,o)=>o.method==='POST'?{ok:false,status:400,json:async()=>({code:'term_exists',message:'A term with the name provided already exists.'})}:{ok:true,json:async()=>[]};
 await assert.rejects(makeService(env,exists)('create_term',{site_id:'site-a',taxonomy:'tag',name:'Y'}),/list_categories or list_tags/);
});

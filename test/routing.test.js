'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService, tools, VERSION} = require('../server/service.js');
const {sites, env, mock, runChild, slot, seoSchema} = require('./helpers.js');

test('discovery exposes only IDs, labels and URLs without credentials or requests',async()=>{
 const m=mock([]);const result=await makeService(env,m.f)('list_sites');
 assert.deepEqual(result.sites,[{site_id:'site-a',label:'Website A',site_url:'https://a.example'},{site_id:'site-b',label:'Website B',site_url:'https://b.example/blog'}]);assert.equal(m.calls.length,0);
 assert(!JSON.stringify(result).includes('aaaa'));assert(!JSON.stringify(result).includes('alice'));
});
test('connection routes URL and credentials independently, reports destination',async()=>{
 const m=mock([{id:1,capabilities:{publish_posts:true}},{id:2,capabilities:{upload_files:true}}]);const call=makeService(env,m.f);
 const a=await call('test_connection',{site_id:'site-a'});const b=await call('test_connection',{site_id:'site-b'});
 assert.equal(a.data.user_id,1);assert.equal(b.data.user_id,2);assert.equal(b.site_id,'site-b');
 assert.equal(m.calls[0].u,'https://a.example/wp-json/wp/v2/users/me?context=edit');assert.equal(m.calls[1].u,'https://b.example/blog/wp-json/wp/v2/users/me?context=edit');
 assert.equal(m.calls[0].o.headers.Authorization,'Basic '+Buffer.from('alice:aaaabbbb').toString('base64'));assert.equal(m.calls[1].o.headers.Authorization,'Basic '+Buffer.from('bob:ccccdddd').toString('base64'));assert.equal(m.calls[0].o.redirect,'error');
});
test('missing and unknown destination never fall back or make requests',async()=>{
 const m=mock([]);const call=makeService(env,m.f);
 for(const t of tools.filter(t=>t.name!=='list_sites'))await assert.rejects(call(t.name,{}),/Missing site_id/);
 await assert.rejects(call('get_post',{site_id:'missing',post_id:1}),/Unknown site_id/);assert.equal(m.calls.length,0);
});
test('overlapping post IDs stay on selected sites for reading, updating and publishing',async()=>{
 const m=mock([{id:12,status:'draft',title:{raw:'T'}},{id:12,status:'draft',title:{raw:'T'}},{id:12,status:'draft',title:{raw:'T'}},{id:12,status:'draft',title:{raw:'T'}},{id:12,status:'draft',title:{raw:'T'}},{id:12,status:'publish',title:{raw:'T'}}]);const call=makeService(env,m.f);
 const a=await call('get_post',{site_id:'site-a',post_id:12});const b=await call('get_post',{site_id:'site-b',post_id:12});assert.equal(a.site_id,'site-a');assert.equal(b.site_id,'site-b');
 await call('update_draft',{site_id:'site-b',post_id:12,title:'B draft',featured_media:0});await call('publish_post',{site_id:'site-a',post_id:12,confirm_title:'T',confirm_publish:true});
 assert(m.calls.slice(2,4).every(c=>c.u.startsWith('https://b.example/blog/')));assert(m.calls.slice(4).every(c=>c.u.startsWith('https://a.example/')));
 assert.deepEqual(JSON.parse(m.calls[3].o.body),{title:'B draft',featured_media:0});assert.deepEqual(JSON.parse(m.calls[5].o.body),{status:'publish'});
});
test('duplicate slug on site A does not block an independent draft on site B',async()=>{
 const m=mock([[{id:10}],[],{id:10,status:'draft'}]);const call=makeService(env,m.f);
 await assert.rejects(call('create_draft',{site_id:'site-a',title:'A',content:'A',slug:'same'}),/site site-a/);
 const result=await call('create_draft',{site_id:'site-b',title:'B',content:'B',slug:'same'});assert.equal(result.site_id,'site-b');assert.equal(m.calls.length,3);
});
test('unknown prototype properties are rejected',async()=>{
 await assert.rejects(makeService(env)('list_sites',JSON.parse('{"__proto__":{}}')),/Unknown argument/);
});
test('B1: non-JSON error pages report the HTTP status and a firewall hint, even for reads',async()=>{
 const html=status=>async()=>({ok:status<400,status,json:async()=>{throw new SyntaxError('Unexpected token <');}});
 await assert.rejects(makeService(env,html(403))('get_post',{site_id:'site-a',post_id:1}),e=>/HTTP 403/.test(e.message)&&/firewall/.test(e.message)&&!/unreadable/.test(e.message));
 await assert.rejects(makeService(env,html(200))('get_post',{site_id:'site-a',post_id:1}),e=>/unreadable response \(HTTP 200\)/.test(e.message)&&/firewall/.test(e.message));
});
test('B2: WordPress error message is appended, HTML-stripped and capped at 200 characters',async()=>{
 const fail=message=>async()=>({ok:false,status:403,json:async()=>({code:'rest_cannot_create',message})});
 await assert.rejects(makeService(env,fail('Sorry, you are <b>not allowed</b> to create posts as this user.'))('get_post',{site_id:'site-a',post_id:1}),e=>e.message.includes('WordPress HTTP 403 (rest_cannot_create): Sorry, you are not allowed to create posts as this user.')&&!e.message.includes('<b>'));
 await assert.rejects(makeService(env,fail('x'.repeat(500)))('get_post',{site_id:'site-a',post_id:1}),e=>e.message.includes('x'.repeat(200))&&!e.message.includes('x'.repeat(201)));
 await assert.rejects(makeService(env,async()=>({ok:false,status:401,json:async()=>({code:'rest_not_logged_in'})}))('get_post',{site_id:'site-a',post_id:1}),/HTTP 401 \(rest_not_logged_in\)\. Check credentials/);
});
test('F9: plain-permalink sites fall back to ?rest_route= once and remember it per site',async()=>{
 const calls=[];const f=async(u,o)=>{calls.push({u,o});if(u.includes('/wp-json/'))return {ok:false,status:404,json:async()=>{throw new SyntaxError('html');}};return {ok:true,json:async()=>u.includes('users')?{id:1,capabilities:{}}:{id:8,status:'draft'}};};
 const call=makeService(env,f);
 const t=await call('test_connection',{site_id:'site-b'});assert.equal(t.data.user_id,1);assert.match(t.data.rest_api_style,/plain/);
 assert.deepEqual(calls.map(c=>c.u),['https://b.example/blog/wp-json/wp/v2/users/me?context=edit','https://b.example/blog/?rest_route=/wp/v2/users/me&context=edit']);
 await call('update_draft',{site_id:'site-b',post_id:8,title:'New'});assert.deepEqual(calls.slice(2).map(c=>c.u),['https://b.example/blog/?rest_route=/wp/v2/posts/8&context=edit','https://b.example/blog/?rest_route=/wp/v2/posts/8']);assert.deepEqual(JSON.parse(calls[3].o.body),{title:'New'});
 calls.length=0;await call('test_connection',{site_id:'site-a'});assert.equal(calls[0].u,'https://a.example/wp-json/wp/v2/users/me?context=edit');
 const waf=async()=>({ok:false,status:404,json:async()=>{throw new SyntaxError('html');}});
 await assert.rejects(makeService(env,waf)('test_connection',{site_id:'site-a'}),/HTTP 404 returned a non-JSON page/);
});

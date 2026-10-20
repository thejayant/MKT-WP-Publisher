'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService, tools, VERSION} = require('../server/service.js');
const {sites, env, mock, runChild, slot, seoSchema, png} = require('./helpers.js');

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

test('F10: plain http is allowed only for local development hosts', async () => {
  const profile = site_url => ({WP_SITES_JSON: JSON.stringify([{...sites[0], site_url}])});
  for (const url of ['http://localhost:8080', 'http://127.0.0.1', 'http://mysite.local', 'http://shop.test/blog', 'http://app.localhost']) {
    const r = await makeService(profile(url))('list_sites');
    assert.equal(r.sites[0].site_url, url.replace(/\/$/, ''));
  }
  for (const url of ['http://example.com', 'http://local.example.com', 'http://10.0.0.5']) {
    await assert.rejects(makeService(profile(url))('list_sites'), /only for local development sites/);
  }
});

test('F17: reads are retried on 429/502/503/504 with backoff; writes never are', async () => {
  const delays = [];
  const sleep = async ms => { delays.push(ms); };
  const reply = (status, body, headers = {}) => ({ok: status < 400, status, headers: {get: k => headers[k]}, json: async () => body});

  let calls = 0;
  const flaky = async () => (++calls < 3 ? reply(503, {code: 'busy'}) : reply(200, {id: 1, capabilities: {}}));
  const ok = await makeService(env, flaky, {sleep})('test_connection', {site_id: 'site-a'});
  assert.equal(ok.data.user_id, 1);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 3000]);

  delays.length = 0;
  calls = 0;
  const limited = async () => (++calls === 1 ? reply(429, {code: 'rate'}, {'Retry-After': '30'}) : reply(200, {id: 2, capabilities: {}}));
  await makeService(env, limited, {sleep})('test_connection', {site_id: 'site-a'});
  assert.deepEqual(delays, [10000], 'Retry-After is honoured but capped at 10 s');

  delays.length = 0;
  calls = 0;
  const down = async () => { calls++; return reply(502, {code: 'bad_gateway'}); };
  await assert.rejects(makeService(env, down, {sleep})('test_connection', {site_id: 'site-a'}), /HTTP 502/);
  assert.equal(calls, 3, 'one try plus two retries');

  calls = 0;
  const writeFails = async (u, o) => { calls++; return o.method === 'POST' ? reply(503, {code: 'busy'}) : reply(200, {id: 9, status: 'draft'}); };
  await assert.rejects(makeService(env, writeFails, {sleep})('update_draft', {site_id: 'site-a', post_id: 9, title: 'T'}), /HTTP 503/);
  assert.equal(calls, 2, 'the GET ran once and the POST was not retried');
});

test('B10: uploads get a longer timeout than other requests', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-timeout-'));
  try {
    await fs.writeFile(path.join(dir, 'big.png'), png('x'));
    // Every response takes 80 ms; requests time out after 30 ms, uploads after 1 s.
    const slow = async (u, o) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 80);
        o.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
      });
      return {ok: true, json: async () => ({id: 3, source_url: 'https://a.example/big.png'})};
    };
    const timeouts = {request: 30, upload: 1000};
    await assert.rejects(makeService(env, slow, {timeouts})('test_connection', {site_id: 'site-a'}), /timed out/);
    const call = makeService({...env, WP_IMAGE_DIR: dir}, slow, {timeouts: {request: 1000, upload: 1000}});
    assert.equal((await call('upload_image', {site_id: 'site-a', file_name: 'big.png', alt_text: 'Big'})).data.media_id, 3);
    // Only the media POST uses the upload limit: with a short request limit the metadata step times out.
    await assert.rejects(makeService({...env, WP_IMAGE_DIR: dir}, slow, {timeouts})('upload_image', {site_id: 'site-a', file_name: 'big.png', alt_text: 'Big'}), /media ID 3 but metadata update failed/);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('H9: debug log lists site, method, path, status and time only when enabled', async () => {
  const lines = [];
  const log = line => lines.push(line);
  const m = mock([[{id: 1, status: 'draft', title: {raw: 'T'}}]]);
  await makeService({...env, MKT_WP_DEBUG: 'true'}, m.f, {log})('list_posts', {site_id: 'site-a', search: 'secret words'});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^site-a GET \/posts \d{3}|^site-a GET \/posts undefined/);
  assert(!lines[0].includes('secret'), 'query text is left out');
  assert(!lines[0].includes('Basic'), 'credentials are left out');

  lines.length = 0;
  for (const flag of [undefined, 'false', '${user_config.debug_log}']) {
    await makeService({...env, MKT_WP_DEBUG: flag}, mock([[]]).f, {log})('list_posts', {site_id: 'site-a'});
  }
  assert.equal(lines.length, 0);
});

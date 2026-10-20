'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService, tools, VERSION} = require('../server/service.js');
const {sites, env, mock, runChild, slot, seoSchema} = require('./helpers.js');

test('active cancellation aborts the read and prevents follow-up publishing POST',async()=>{
 const controller=new AbortController();let count=0;
 const fetcher=async(u,o)=>{count++;controller.abort();assert(o.signal.aborted);return {ok:true,json:async()=>({id:1,status:'draft'})};};
 await assert.rejects(makeService(env,fetcher)('publish_post',{site_id:'site-a',post_id:1,confirm_title:'T',confirm_publish:true},controller.signal),/cancelled/);assert.equal(count,1);
});
test('startup discovery and malformed envelope response',async()=>{
 const r=await runChild([{jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:1,method:'tools/list'},'null',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_sites',arguments:{}}}]);
 assert.equal(r.find(x=>x.id===0).result.serverInfo.version,VERSION);assert.equal(r.find(x=>x.id===1).result.tools.length,14);assert.equal(r.find(x=>x.id===null).error.code,-32600);assert.equal(r.find(x=>x.id===2).result.isError,true);
});
test('cancelled queued publish never reaches fetch; next queued request still runs',async()=>{
 const boot='Object.assign(process.env,'+JSON.stringify(env)+');global.fetch=async(u,o)=>{if(o.method==="POST"){process.stderr.write("Unexpected write");throw new Error("Unexpected write");}await new Promise(r=>setTimeout(r,60));return {ok:true,json:async()=>({id:1,status:"draft",capabilities:{}})}}';
 const r=await runChild([{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'test_connection',arguments:{site_id:'site-a'}}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'publish_post',arguments:{site_id:'site-b',post_id:1,confirm_title:'T',confirm_publish:true}}},{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:2}},{jsonrpc:'2.0',id:3,method:'ping'}],boot);
 assert(!r.some(x=>x.id===2));assert(r.some(x=>x.id===1));assert(r.some(x=>x.id===3));
});
test('ping and tools/list are answered while a slow tool call is still running',async()=>{
 const boot='Object.assign(process.env,'+JSON.stringify(env)+');global.fetch=async()=>{await new Promise(r=>setTimeout(r,400));return {ok:true,json:async()=>({id:1,capabilities:{}})}}';
 const r=await runChild([{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'test_connection',arguments:{site_id:'site-a'}}},{jsonrpc:'2.0',id:2,method:'ping'},{jsonrpc:'2.0',id:3,method:'tools/list'}],boot);
 assert.deepEqual(r.map(x=>x.id),[2,3,1]);assert.equal(r[2].result.isError,undefined);
});
test('B8: only publish_post and schedule_post are destructive; update_draft is idempotent',()=>{
 const a=Object.fromEntries(tools.map(t=>[t.name,t.annotations]));
 assert.deepEqual(tools.filter(t=>t.annotations.destructiveHint).map(t=>t.name),['publish_post','schedule_post']);
 assert.equal(a.update_draft.idempotentHint,true);assert.equal(a.create_draft.idempotentHint,false);assert.equal(a.upload_image.idempotentHint,false);assert.equal(a.publish_post.readOnlyHint,false);
 for(const t of tools.filter(t=>t.annotations.readOnlyHint))assert.equal(t.annotations.idempotentHint,true);
});

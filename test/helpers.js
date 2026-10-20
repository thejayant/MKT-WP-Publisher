'use strict';
// Shared fixtures for the test files.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const sites=[{id:'site-a',label:'Website A',site_url:'https://a.example',username:'alice',application_password:'aaaa bbbb'},{id:'site-b',label:'Website B',site_url:'https://b.example/blog/',username:'bob',application_password:'cccc dddd'}];
const env={WP_SITES_JSON:JSON.stringify(sites)};
function mock(values){const calls=[];return {calls,f:async(u,o)=>{calls.push({u,o});const v=values.shift();if(v instanceof Error)throw v;return {ok:true,json:async()=>v};}};}
async function runChild(messages,bootstrap=''){
 const entry=path.join(__dirname,'../server/index.js');const child=spawn(process.execPath,['-e',bootstrap+';require('+JSON.stringify(entry)+')'],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});child.stdin.end(messages.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('\n')+'\n');assert.equal(await done,0,err);assert.equal(err,'');return out.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
}
function slot(n,dir,overrides={}) {
 const prefix='WP_SITE_'+n+'_';
 return Object.fromEntries(Object.entries({ENABLED:'true',LABEL:'Website '+n,URL:'https://site'+n+'.example',USERNAME:'user'+n,APP_PASSWORD:'fake-'+n,IMAGE_DIR:dir,...overrides}).map(([key,value])=>[prefix+key,value]));
}
const seoSchema=plugin=>({schema:{properties:{mkt_seo:{properties:{plugin:{enum:[plugin]}}}}}});
module.exports = {sites, env, mock, runChild, slot, seoSchema};

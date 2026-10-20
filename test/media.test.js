'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService, tools, VERSION} = require('../server/service.js');
const {sites, env, mock, runChild, slot, seoSchema} = require('./helpers.js');

test('image upload and metadata stay on selected site and return paired ID',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wp-multi-'));try{
 await fs.writeFile(path.join(dir,'image.png'),Buffer.from('89504e470d0a1a0a','hex'));
 const m=mock([{id:5,source_url:'https://b.example/image.png'},{id:5}]);const call=makeService({...env,WP_IMAGE_DIR:dir},m.f);
 const result=await call('upload_image',{site_id:'site-b',file_name:'image.png',alt_text:'Example'});assert.equal(result.site_id,'site-b');assert.equal(result.data.media_id,5);assert(m.calls.every(c=>c.u.startsWith('https://b.example/blog/')));assert.equal(m.calls[0].o.headers['Content-Type'],'image/png');assert.deepEqual(JSON.parse(m.calls[1].o.body),{alt_text:'Example',title:'image'});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('metadata failure reports selected site and existing media ID',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wp-multi-'));try{
 await fs.writeFile(path.join(dir,'image.png'),'fixture');const m=mock([{id:5},new Error('secret from transport')]);
 await assert.rejects(makeService({...env,WP_IMAGE_DIR:dir},m.f)('upload_image',{site_id:'site-b',file_name:'image.png',alt_text:'Example'}),/site site-b as media ID 5/);assert.equal(m.calls.length,2);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('path traversal rejected independently of symlink support',async()=>{
 const m=mock([]);await assert.rejects(makeService({...env,WP_IMAGE_DIR:__dirname},m.f)('upload_image',{site_id:'site-a',file_name:'../out.png',alt_text:'x'}),/file name/);assert.equal(m.calls.length,0);
});
test('external symlinks rejected when supported',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wp-multi-'));try{
 await fs.mkdir(path.join(dir,'images'));await fs.writeFile(path.join(dir,'out.png'),'fixture');
 try{await fs.symlink(path.join(dir,'out.png'),path.join(dir,'images','escape.png'));}catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Host does not permit file symlinks');return;}throw e;}
 await assert.rejects(makeService({...env,WP_IMAGE_DIR:path.join(dir,'images')},mock([]).f)('upload_image',{site_id:'site-a',file_name:'escape.png',alt_text:'x'}),/symlink/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('same filenames upload different bytes from each selected website folder',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wp-isolation-'));try{
 const a=path.join(root,'a'),b=path.join(root,'b'),old=path.join(root,'old');for(const dir of [a,b,old])await fs.mkdir(dir);
 await fs.writeFile(path.join(a,'blog.png'),'A-contents');await fs.writeFile(path.join(b,'blog.png'),'B-contents');await fs.writeFile(path.join(old,'blog.png'),'OLD-contents');
 const m=mock([{id:7},{id:7},{id:7},{id:7}]);const call=makeService({...slot(1,a),...slot(2,b),WP_IMAGE_DIR:old},m.f);
 await call('upload_image',{site_id:'website-1',file_name:'blog.png',alt_text:'A'});await call('upload_image',{site_id:'website-2',file_name:'blog.png',alt_text:'B'});
 assert.equal(m.calls[0].o.body.toString(),'A-contents');assert.equal(m.calls[2].o.body.toString(),'B-contents');assert(m.calls.slice(0,2).every(c=>c.u.startsWith('https://site1.example/')));assert(m.calls.slice(2).every(c=>c.u.startsWith('https://site2.example/')));
 assert.equal(m.calls[2].o.headers.Authorization,'Basic '+Buffer.from('user2:fake-2').toString('base64'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('file existing only in another website folder cannot be uploaded from selected site',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wp-isolation-'));try{
 const a=path.join(root,'a'),b=path.join(root,'b');await fs.mkdir(a);await fs.mkdir(b);await fs.writeFile(path.join(b,'private.png'),'B-only');
 const m=mock([]);await assert.rejects(makeService({...slot(1,a),...slot(2,b)},m.f)('upload_image',{site_id:'website-1',file_name:'private.png',alt_text:'x'}),/missing or inaccessible for site website-1/);assert.equal(m.calls.length,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('B5: blank alt_text is rejected before reading files or making requests',async()=>{
 const m=mock([]);await assert.rejects(makeService({...env,WP_IMAGE_DIR:__dirname},m.f)('upload_image',{site_id:'site-a',file_name:'image.png',alt_text:'  '}),/alt_text cannot be blank/);assert.equal(m.calls.length,0);
});
test('F1: list_images lists only uploadable types in the selected site folder, without requests',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wp-images-'));try{
 const a=path.join(root,'a'),b=path.join(root,'b');for(const d of [a,b,path.join(a,'sub')])await fs.mkdir(d);
 await fs.writeFile(path.join(a,'Garage.PNG'),'x');await fs.writeFile(path.join(a,'beach.webp'),'xy');await fs.writeFile(path.join(a,'notes.txt'),'x');await fs.writeFile(path.join(a,'sub','deep.png'),'x');await fs.writeFile(path.join(b,'other.jpg'),'x');
 const m=mock([]);const call=makeService({...slot(1,a),...slot(2,b)},m.f);
 const r=await call('list_images',{site_id:'website-1'});assert.equal(m.calls.length,0);
 assert.deepEqual(r.data.items.map(i=>[i.file_name,i.type,i.size_bytes]),[['beach.webp','image/webp',2],['Garage.PNG','image/png',1]]);assert.equal(r.data.total,2);assert.equal(r.data.truncated,false);
 assert.deepEqual((await call('list_images',{site_id:'website-1',search:'gar'})).data.items.map(i=>i.file_name),['Garage.PNG']);
 assert.deepEqual((await call('list_images',{site_id:'website-2'})).data.items.map(i=>i.file_name),['other.jpg']);
 await assert.rejects(makeService({...slot(1,path.join(root,'missing'))})('list_images',{site_id:'website-1'}),/missing or inaccessible for site website-1/);
 assert.equal(tools.find(t=>t.name==='list_images').annotations.openWorldHint,false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

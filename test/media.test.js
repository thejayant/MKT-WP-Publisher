'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService, tools, VERSION} = require('../server/service.js');
const {sites, env, mock, runChild, slot, seoSchema, png} = require('./helpers.js');

test('image upload and metadata stay on selected site and return paired ID',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wp-multi-'));try{
 await fs.writeFile(path.join(dir,'image.png'),Buffer.from('89504e470d0a1a0a','hex'));
 const m=mock([{id:5,source_url:'https://b.example/image.png'},{id:5}]);const call=makeService({...env,WP_IMAGE_DIR:dir},m.f);
 const result=await call('upload_image',{site_id:'site-b',file_name:'image.png',alt_text:'Example'});assert.equal(result.site_id,'site-b');assert.equal(result.data.media_id,5);assert(m.calls.every(c=>c.u.startsWith('https://b.example/blog/')));assert.equal(m.calls[0].o.headers['Content-Type'],'image/png');assert.deepEqual(JSON.parse(m.calls[1].o.body),{alt_text:'Example',title:'image'});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('metadata failure reports selected site and existing media ID',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wp-multi-'));try{
 await fs.writeFile(path.join(dir,'image.png'),png('fixture'));const m=mock([{id:5},new Error('secret from transport')]);
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
 await fs.writeFile(path.join(a,'blog.png'),png('A-contents'));await fs.writeFile(path.join(b,'blog.png'),png('B-contents'));await fs.writeFile(path.join(old,'blog.png'),png('OLD-contents'));
 const m=mock([{id:7},{id:7},{id:7},{id:7}]);const call=makeService({...slot(1,a),...slot(2,b),WP_IMAGE_DIR:old},m.f);
 await call('upload_image',{site_id:'website-1',file_name:'blog.png',alt_text:'A'});await call('upload_image',{site_id:'website-2',file_name:'blog.png',alt_text:'B'});
 assert.deepEqual(m.calls[0].o.body,png('A-contents'));assert.deepEqual(m.calls[2].o.body,png('B-contents'));assert(m.calls.slice(0,2).every(c=>c.u.startsWith('https://site1.example/')));assert(m.calls.slice(2).every(c=>c.u.startsWith('https://site2.example/')));
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

test('F14: image content must match its extension; GIF and AVIF are supported', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-sniff-'));
  try {
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
    const avif = Buffer.concat([Buffer.from('0000001c', 'hex'), Buffer.from('ftypavif'), Buffer.alloc(8)]);
    await fs.writeFile(path.join(dir, 'renamed.png'), jpeg);
    await fs.writeFile(path.join(dir, 'anim.gif'), gif);
    await fs.writeFile(path.join(dir, 'photo.avif'), avif);
    await fs.writeFile(path.join(dir, 'text.webp'), 'not an image');

    const m = mock([{id: 4, source_url: 'https://a.example/anim.gif'}, {id: 4}]);
    const call = makeService({...env, WP_IMAGE_DIR: dir}, m.f);
    await assert.rejects(call('upload_image', {site_id: 'site-a', file_name: 'renamed.png', alt_text: 'x'}), /content of renamed\.png is image\/jpeg, but its extension says image\/png.*nothing was uploaded/);
    await assert.rejects(call('upload_image', {site_id: 'site-a', file_name: 'text.webp', alt_text: 'x'}), /is not a supported image/);
    assert.equal(m.calls.length, 0);
    await call('upload_image', {site_id: 'site-a', file_name: 'anim.gif', alt_text: 'Animation'});
    assert.equal(m.calls[0].o.headers['Content-Type'], 'image/gif');

    const listed = Object.fromEntries((await call('list_images', {site_id: 'site-a'})).data.items.map(i => [i.file_name, i]));
    assert.equal(listed['photo.avif'].type, 'image/avif');
    assert(!('uploadable' in listed['photo.avif']));
    assert(!('uploadable' in listed['anim.gif']));
    assert.equal(listed['renamed.png'].uploadable, false);
    assert.match(listed['renamed.png'].reason, /does not match/);
    assert.equal(listed['text.webp'].uploadable, false);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('F8: upload_image returns an html figure and can set the featured image of a draft', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-featured-'));
  try {
    await fs.writeFile(path.join(dir, 'hero.png'), png('hero'));
    const media = {id: 31, source_url: 'https://b.example/blog/hero.png'};
    const m = mock([{id: 7, status: 'draft'}, media, {id: 31}, {id: 7, featured_media: 31}]);
    const call = makeService({...env, WP_IMAGE_DIR: dir}, m.f);
    const r = await call('upload_image', {site_id: 'site-b', file_name: 'hero.png', alt_text: 'Team "hero" shot', featured_for_post_id: 7});
    assert.equal(r.data.html, '<figure class="wp-block-image"><img src="https://b.example/blog/hero.png" alt="Team &quot;hero&quot; shot" class="wp-image-31" /></figure>');
    assert.equal(r.data.featured_for_post_id, 7);
    assert.match(m.calls[0].u, /\/posts\/7\?context=edit$/);
    assert.equal(m.calls[3].u, 'https://b.example/blog/wp-json/wp/v2/posts/7');
    assert.deepEqual(JSON.parse(m.calls[3].o.body), {featured_media: 31});

    const published = mock([{id: 7, status: 'publish'}]);
    await assert.rejects(makeService({...env, WP_IMAGE_DIR: dir}, published.f)('upload_image', {site_id: 'site-b', file_name: 'hero.png', alt_text: 'x', featured_for_post_id: 7}), /draft or pending post; nothing was uploaded/);
    assert.equal(published.calls.length, 1);

    const page = mock([{id: 9, status: 'draft'}, media, {id: 31}, {id: 9}]);
    await makeService({...env, WP_IMAGE_DIR: dir}, page.f)('upload_image', {site_id: 'site-b', file_name: 'hero.png', alt_text: 'x', featured_for_post_id: 9, post_type: 'page'});
    assert(page.calls[0].u.includes('/pages/9') && page.calls[3].u.endsWith('/pages/9'));

    await assert.rejects(call('upload_image', {site_id: 'site-b', file_name: 'hero.png', alt_text: 'x', post_type: 'page'}), /only used with featured_for_post_id/);

    const failing = mock([{id: 7, status: 'draft'}, media, {id: 31}, new Error('down')]);
    await assert.rejects(makeService({...env, WP_IMAGE_DIR: dir}, failing.f)('upload_image', {site_id: 'site-b', file_name: 'hero.png', alt_text: 'x', featured_for_post_id: 7}), /media ID 31, but setting it as the featured image of 7 failed.*update_draft with featured_media 31/);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

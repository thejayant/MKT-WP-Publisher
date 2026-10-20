const {test}=require('node:test');
const assert=require('node:assert/strict');
const {makeService,tools,VERSION}=require('../server/service');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const sites=[{id:'site-a',label:'Website A',site_url:'https://a.example',username:'alice',application_password:'aaaa bbbb'},{id:'site-b',label:'Website B',site_url:'https://b.example/blog/',username:'bob',application_password:'cccc dddd'}];
const env={WP_SITES_JSON:JSON.stringify(sites)};
function mock(values){const calls=[];return {calls,f:async(u,o)=>{calls.push({u,o});const v=values.shift();if(v instanceof Error)throw v;return {ok:true,json:async()=>v};}};}
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
test('legacy config becomes default; populated multi-site config takes precedence',async()=>{
 const legacy={WP_SITE_URL:'https://old.example',WP_USERNAME:'old',WP_APP_PASSWORD:'fake'};
 const list=await makeService(legacy)('list_sites');assert.equal(list.sites[0].site_id,'default');
 const current=await makeService({...legacy,...env})('list_sites');assert.equal(current.sites.length,2);assert(!JSON.stringify(current).includes('old.example'));
});
test('bad JSON never echoes secrets or falls back to legacy',async()=>{
 const broken={...env,WP_SITES_JSON:'[{"application_password":"SECRET',WP_SITE_URL:'https://old.example',WP_USERNAME:'old',WP_APP_PASSWORD:'fake'};
 await assert.rejects(makeService(broken)('list_sites'),e=>!e.message.includes('SECRET')&&/not valid JSON/.test(e.message));
});
test('duplicate IDs, unsafe URLs, malformed records and empty arrays rejected',async()=>{
 for(const profiles of [[sites[0],sites[0]],[],[{...sites[0],site_url:'http://a.example'}],[{...sites[0],site_url:'https://user:pass@a.example'}],[{...sites[0],site_url:'https://a.example/wp-admin'}],[{...sites[0],application_password:''}],[{...sites[0],id:'../x'}],[{...sites[0],username:'a:b'}]]) await assert.rejects(makeService({WP_SITES_JSON:JSON.stringify(profiles)})('list_sites'));
});
test('overlapping post IDs stay on selected sites for reading, updating and publishing',async()=>{
 const m=mock([{id:12,status:'draft',title:{raw:'T'}},{id:12,status:'draft',title:{raw:'T'}},{id:12,status:'draft',title:{raw:'T'}},{id:12,status:'draft',title:{raw:'T'}},{id:12,status:'draft',title:{raw:'T'}},{id:12,status:'publish',title:{raw:'T'}}]);const call=makeService(env,m.f);
 const a=await call('get_post',{site_id:'site-a',post_id:12});const b=await call('get_post',{site_id:'site-b',post_id:12});assert.equal(a.site_id,'site-a');assert.equal(b.site_id,'site-b');
 await call('update_draft',{site_id:'site-b',post_id:12,title:'B draft',featured_media:0});await call('publish_post',{site_id:'site-a',post_id:12,confirm_title:'T',confirm_publish:true});
 assert(m.calls.slice(2,4).every(c=>c.u.startsWith('https://b.example/blog/')));assert(m.calls.slice(4).every(c=>c.u.startsWith('https://a.example/')));
 assert.deepEqual(JSON.parse(m.calls[3].o.body),{title:'B draft',featured_media:0});assert.deepEqual(JSON.parse(m.calls[5].o.body),{status:'publish'});
});
test('draft creation strips routing fields and forces draft, rejecting injected status',async()=>{
 const m=mock([[],{id:1,status:'draft'}]);const call=makeService(env,m.f);
 const draft=await call('create_draft',{site_id:'site-b',title:'B',content:'<p>B</p>',slug:'same-slug',categories:[1],featured_media:3});assert.equal(draft.site_id,'site-b');
 assert.deepEqual(JSON.parse(m.calls[1].o.body),{title:'B',content:'<p>B</p>',slug:'same-slug',categories:[1],featured_media:3,status:'draft'});
 await assert.rejects(call('create_draft',{site_id:'site-b',title:'B',content:'B',slug:'b',status:'publish'}),/Unknown argument/);
});
test('duplicate slug on site A does not block an independent draft on site B',async()=>{
 const m=mock([[{id:10}],[],{id:10,status:'draft'}]);const call=makeService(env,m.f);
 await assert.rejects(call('create_draft',{site_id:'site-a',title:'A',content:'A',slug:'same'}),/site site-a/);
 const result=await call('create_draft',{site_id:'site-b',title:'B',content:'B',slug:'same'});assert.equal(result.site_id,'site-b');assert.equal(m.calls.length,3);
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
test('unknown prototype properties are rejected',async()=>{
 await assert.rejects(makeService(env)('list_sites',JSON.parse('{"__proto__":{}}')),/Unknown argument/);
});
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
test('active cancellation aborts the read and prevents follow-up publishing POST',async()=>{
 const controller=new AbortController();let count=0;
 const fetcher=async(u,o)=>{count++;controller.abort();assert(o.signal.aborted);return {ok:true,json:async()=>({id:1,status:'draft'})};};
 await assert.rejects(makeService(env,fetcher)('publish_post',{site_id:'site-a',post_id:1,confirm_title:'T',confirm_publish:true},controller.signal),/cancelled/);assert.equal(count,1);
});
async function runChild(messages,bootstrap=''){
 const entry=path.join(__dirname,'../server/index.js');const child=spawn(process.execPath,['-e',bootstrap+';require('+JSON.stringify(entry)+')'],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});child.stdin.end(messages.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('\n')+'\n');assert.equal(await done,0,err);assert.equal(err,'');return out.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
}
test('startup discovery and malformed envelope response',async()=>{
 const r=await runChild([{jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:1,method:'tools/list'},'null',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_sites',arguments:{}}}]);
 assert.equal(r.find(x=>x.id===0).result.serverInfo.version,VERSION);assert.equal(r.find(x=>x.id===1).result.tools.length,14);assert.equal(r.find(x=>x.id===null).error.code,-32600);assert.equal(r.find(x=>x.id===2).result.isError,true);
});
test('cancelled queued publish never reaches fetch; next queued request still runs',async()=>{
 const boot='Object.assign(process.env,'+JSON.stringify(env)+');global.fetch=async(u,o)=>{if(o.method==="POST"){process.stderr.write("Unexpected write");throw new Error("Unexpected write");}await new Promise(r=>setTimeout(r,60));return {ok:true,json:async()=>({id:1,status:"draft",capabilities:{}})}}';
 const r=await runChild([{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'test_connection',arguments:{site_id:'site-a'}}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'publish_post',arguments:{site_id:'site-b',post_id:1,confirm_title:'T',confirm_publish:true}}},{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:2}},{jsonrpc:'2.0',id:3,method:'ping'}],boot);
 assert(!r.some(x=>x.id===2));assert(r.some(x=>x.id===1));assert(r.some(x=>x.id===3));
});
function slot(n,dir,overrides={}) {
 const prefix='WP_SITE_'+n+'_';
 return Object.fromEntries(Object.entries({ENABLED:'true',LABEL:'Website '+n,URL:'https://site'+n+'.example',USERNAME:'user'+n,APP_PASSWORD:'fake-'+n,IMAGE_DIR:dir,...overrides}).map(([key,value])=>[prefix+key,value]));
}
test('five section-based sites discovered with individual image folders and no passwords',async()=>{
 let config={};for(let n=1;n<=5;n++)Object.assign(config,slot(n,'C:/BlogImages/Site'+n));
 const r=await makeService(config)('list_sites');assert.equal(r.max_sites,5);assert.equal(r.sites.length,5);assert.deepEqual(r.sites[4],{site_id:'website-5',label:'Website 5',site_url:'https://site5.example',image_folder:'C:/BlogImages/Site5'});assert(!JSON.stringify(r).includes('fake-'));assert(!JSON.stringify(r).includes('user5'));
});
test('website sections override old profiles, ignore disabled incomplete sites and keep stable IDs',async()=>{
 const config={...env,...slot(2,'C:/B'),...slot(1,'',{ENABLED:'false',URL:'',USERNAME:'',APP_PASSWORD:''})};
 const r=await makeService(config)('list_sites');assert.equal(r.sites.length,1);assert.equal(r.sites[0].site_id,'website-2');
});
test('all disabled populated sections cannot silently select an old website',async()=>{
 await assert.rejects(makeService({...env,...slot(1,'C:/A',{ENABLED:'false'})})('list_sites'),/disabled/);
});
test('enabled sections require their own folder and complete credentials',async()=>{
 for(const overrides of [{IMAGE_DIR:''},{APP_PASSWORD:''},{URL:''},{USERNAME:''}])await assert.rejects(makeService({...env,WP_IMAGE_DIR:'C:/OldShared',...slot(1,'C:/A',overrides)})('list_sites'));
});
test('maximum five enforced on old JSON and section configuration',async()=>{
 const six=Array.from({length:6},(_,i)=>({...sites[0],id:'site-'+(i+1)}));
 await assert.rejects(makeService({WP_SITES_JSON:JSON.stringify(six)})('list_sites'),/maximum of 5/);
 await assert.rejects(makeService({...slot(1,'C:/A'),...slot(6,'C:/F')})('list_sites'),/maximum of 5/);
 const five=six.slice(0,5);assert.equal((await makeService({WP_SITES_JSON:JSON.stringify(five)})('list_sites')).sites.length,5);
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
test('old JSON profiles support per-site folders with prior shared-folder fallback',async()=>{
 const profiles=[{...sites[0],image_folder:'C:/A'},sites[1]];const r=await makeService({WP_SITES_JSON:JSON.stringify(profiles),WP_IMAGE_DIR:'C:/OldShared'})('list_sites');assert.equal(r.sites[0].image_folder,'C:/A');assert.equal(r.sites[1].image_folder,'C:/OldShared');
});
test('manifest contains exactly five website groups with secret passwords and own folder pickers',async()=>{
 const m=JSON.parse(await fs.readFile(path.join(__dirname,'../manifest.json'),'utf8'));assert.equal(m.version,VERSION);
 for(let n=1;n<=5;n++) {
 assert.equal(m.user_config['website_'+n+'_enabled'].type,'boolean');assert.equal(m.user_config['website_'+n+'_enabled'].default,false);assert.equal(m.user_config['website_'+n+'_application_password'].sensitive,true);assert.equal(m.user_config['website_'+n+'_image_folder'].type,'directory');
 assert.equal(m.server.mcp_config.env['WP_SITE_'+n+'_IMAGE_DIR'],'${user_config.website_'+n+'_image_folder}');
 }
 assert(!Object.keys(m.user_config).some(k=>k.startsWith('website_6_')));
});
test('unset settings passed as literal placeholders do not block old JSON or single-site setups',async()=>{
 const unset={};for(let n=1;n<=5;n++)for(const k of ['ENABLED','LABEL','URL','USERNAME','APP_PASSWORD','IMAGE_DIR'])unset['WP_SITE_'+n+'_'+k]='${user_config.website_'+n+'_'+k.toLowerCase()+'}';
 const json=await makeService({...unset,WP_SITES_JSON:JSON.stringify(sites),WP_IMAGE_DIR:'${user_config.image_folder}'})('list_sites');assert.deepEqual(json.sites.map(s=>s.site_id),['site-a','site-b']);assert(json.sites.every(s=>!('image_folder' in s)));
 const legacy=await makeService({...unset,WP_SITES_JSON:'${user_config.sites_json}',WP_SITE_URL:'https://old.example',WP_USERNAME:'old',WP_APP_PASSWORD:'fake'})('list_sites');assert.deepEqual(legacy.sites.map(s=>s.site_id),['default']);
});
test('list_tags and list_categories report paging from WordPress headers',async()=>{
 const calls=[];const headers=h=>({get:k=>h[k]});
 const f=async(u,o)=>{calls.push(u);return u.includes('/tags')?{ok:true,headers:headers({'X-WP-Total':'150','X-WP-TotalPages':'2'}),json:async()=>[{id:7,name:'seo'}]}:{ok:true,json:async()=>Array.from({length:100},(_,i)=>({id:i+1}))};};
 const call=makeService(env,f);
 const tags=await call('list_tags',{site_id:'site-b',search:'seo'});assert.equal(calls[0],'https://b.example/blog/wp-json/wp/v2/tags?per_page=100&page=1&search=seo');assert.deepEqual({...tags.data,items:undefined},{items:undefined,page:1,total:150,total_pages:2,has_more:true});assert.equal(tags.data.items[0].id,7);
 const last=await call('list_tags',{site_id:'site-b',page:2});assert.equal(last.data.has_more,false);
 const cats=await call('list_categories',{site_id:'site-a'});assert.equal(cats.data.items.length,100);assert.equal(cats.data.has_more,true);assert(!('total_pages' in cats.data));
});
test('publish_post checks the title, refuses future-dated drafts and warns on an unexpected status',async()=>{
 const m=mock([{id:3,status:'draft',title:{raw:'Real title'}},{id:3,status:'draft',title:{raw:'Real title'},date_gmt:'2999-01-01T09:00:00'},{id:3,status:'draft',title:{raw:'Real  title '},date_gmt:'2020-01-01T09:00:00'},{id:3,status:'pending',title:{raw:'Real title'}}]);const call=makeService(env,m.f);
 await assert.rejects(call('publish_post',{site_id:'site-a',post_id:3,confirm_title:'Other title',confirm_publish:true}),/does not match/);
 await assert.rejects(call('publish_post',{site_id:'site-a',post_id:3,confirm_title:'Real title',confirm_publish:true}),/future date/);
 assert(m.calls.every(c=>c.o.method==='GET'));
 const r=await call('publish_post',{site_id:'site-a',post_id:3,confirm_title:'Real title',confirm_publish:true});assert.equal(m.calls[3].o.method,'POST');assert.equal(r.data.status,'pending');assert.match(r.data.warning,/not publish/);
 await assert.rejects(makeService(env,mock([]).f)('publish_post',{site_id:'site-a',post_id:3,confirm_publish:true}),/Missing confirm_title/);
});
test('ping and tools/list are answered while a slow tool call is still running',async()=>{
 const boot='Object.assign(process.env,'+JSON.stringify(env)+');global.fetch=async()=>{await new Promise(r=>setTimeout(r,400));return {ok:true,json:async()=>({id:1,capabilities:{}})}}';
 const r=await runChild([{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'test_connection',arguments:{site_id:'site-a'}}},{jsonrpc:'2.0',id:2,method:'ping'},{jsonrpc:'2.0',id:3,method:'tools/list'}],boot);
 assert.deepEqual(r.map(x=>x.id),[2,3,1]);assert.equal(r[2].result.isError,undefined);
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
test('B3: configuration errors name the site by ID or number without echoing values',async()=>{
 const tmp='C:/X';
 await assert.rejects(makeService({...slot(1,tmp),...slot(3,tmp,{APP_PASSWORD:''})})('list_sites'),e=>/Site website-3 requires/.test(e.message)&&!e.message.includes('user3'));
 await assert.rejects(makeService({WP_SITES_JSON:JSON.stringify([sites[0],{...sites[1],site_url:'http://b.example'}])})('list_sites'),e=>/Site site-b/.test(e.message)&&!e.message.includes('b.example'));
 await assert.rejects(makeService({WP_SITES_JSON:JSON.stringify([sites[0],{...sites[1],id:'Bad ID'}])})('list_sites'),e=>/Site number 2/.test(e.message)&&!e.message.includes('Bad ID'));
});
test('B4: update_draft with no fields is rejected without requests',async()=>{
 const m=mock([]);await assert.rejects(makeService(env,m.f)('update_draft',{site_id:'site-a',post_id:1}),/at least one field/);assert.equal(m.calls.length,0);
});
test('B5: blank alt_text is rejected before reading files or making requests',async()=>{
 const m=mock([]);await assert.rejects(makeService({...env,WP_IMAGE_DIR:__dirname},m.f)('upload_image',{site_id:'site-a',file_name:'image.png',alt_text:'  '}),/alt_text cannot be blank/);assert.equal(m.calls.length,0);
});
test('B6: manifest sites_json wording refers to earlier JSON setups, not v1.1.x',async()=>{
 const m=JSON.parse(await fs.readFile(path.join(__dirname,'../manifest.json'),'utf8'));
 assert.match(m.user_config.sites_json.description,/for users of earlier JSON setups/);assert.doesNotMatch(m.user_config.sites_json.description,/v1\.1\.x/);
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
test('B8: only publish_post and schedule_post are destructive; update_draft is idempotent',()=>{
 const a=Object.fromEntries(tools.map(t=>[t.name,t.annotations]));
 assert.deepEqual(tools.filter(t=>t.annotations.destructiveHint).map(t=>t.name),['publish_post','schedule_post']);
 assert.equal(a.update_draft.idempotentHint,true);assert.equal(a.create_draft.idempotentHint,false);assert.equal(a.upload_image.idempotentHint,false);assert.equal(a.publish_post.readOnlyHint,false);
 for(const t of tools.filter(t=>t.annotations.readOnlyHint))assert.equal(t.annotations.idempotentHint,true);
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
test('F2: list_posts defaults to drafts/pending, supports all and search, returns compact items',async()=>{
 const m=mock([[{id:4,status:'draft',title:{raw:'Spring',rendered:'Spring'},slug:'spring',link:'https://a.example/?p=4',author:2,modified_gmt:'2026-10-19T10:00:00'}],[{id:5,status:'publish',title:{raw:'Live'},slug:'live',link:'https://a.example/live'}]]);const call=makeService(env,m.f);
 const r=await call('list_posts',{site_id:'site-a',search:'spring & co'});
 assert.match(m.calls[0].u,/^https:\/\/a\.example\/wp-json\/wp\/v2\/posts\?context=edit&per_page=50&page=1&status=draft,pending&orderby=modified&order=desc&search=spring%20%26%20co&_fields=/);
 assert.deepEqual(r.data.items[0],{post_id:4,status:'draft',title:'Spring',slug:'spring',url:'https://a.example/?p=4',author:2,modified_gmt:'2026-10-19T10:00:00',preview_url:'https://a.example/?p=4&preview=true'});assert.equal(r.data.has_more,false);
 const all=await call('list_posts',{site_id:'site-a',status:'all',page:2});assert.match(m.calls[1].u,/status=draft,pending,future,publish,private/);assert.match(m.calls[1].u,/page=2/);assert(!('preview_url' in all.data.items[0]));
 await assert.rejects(call('list_posts',{site_id:'site-a',status:'trash'}),/must be one of/);assert.equal(m.calls.length,2);
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
const {markdownToHtml}=require('../server/markdown.js');
const seoSchema=plugin=>({schema:{properties:{mkt_seo:{properties:{plugin:{enum:[plugin]}}}}}});
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
test('F12: markdown converter covers common blog formatting and drops unsafe links',()=>{
 const cases=[
  ['# Title *one*','<h1>Title <em>one</em></h1>'],
  ['Line one\nline two','<p>Line one line two</p>'],
  ['Hard  \nbreak','<p>Hard<br />break</p>'],
  ['Back\\\nslash','<p>Back<br />slash</p>'],
  ['AT&T and &amp; and `a < b`','<p>AT&amp;T and &amp; and <code>a &lt; b</code></p>'],
  ['[Site](https://example.com "Home") ![Alt "x"](/img.png)','<p><a href="https://example.com" title="Home">Site</a> <img src="/img.png" alt="Alt &quot;x&quot;" /></p>'],
  ['[bad](javascript:alert(1)) [w](https://en.wikipedia.org/wiki/A_(b))','<p>bad <a href="https://en.wikipedia.org/wiki/A_(b)">w</a></p>'],
  ['- a\n- b\n  - c\n- d','<ul><li>a</li><li>b\n<ul><li>c</li></ul></li><li>d</li></ul>'],
  ['- a\n\n- b','<ul><li><p>a</p></li><li><p>b</p></li></ul>'],
  ['3. x\n4. y','<ol start="3"><li>x</li><li>y</li></ol>'],
  ['> quote\n> more','<blockquote><p>quote more</p></blockquote>'],
  ['```js\nif (a < b) {}\n```','<pre><code class="language-js">if (a &lt; b) {}</code></pre>'],
  ['| A | B |\n|:--|--:|\n| 1 | 2 |','<table><thead><tr><th style="text-align:left">A</th><th style="text-align:right">B</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr></tbody></table>'],
  ['---','<hr />'],
  ['<div class="cta">Raw</div>','<div class="cta">Raw</div>'],
  ['~~old~~ snake_case_name __strong__','<p><del>old</del> snake_case_name <strong>strong</strong></p>'],
  ['Text\r\n\r\nNext','<p>Text</p>\n<p>Next</p>']
 ];
 for(const [md,html] of cases)assert.equal(markdownToHtml(md),html,md);
});

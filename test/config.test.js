'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {makeService, tools, VERSION} = require('../server/service.js');
const {sites, env, mock, runChild, slot, seoSchema, png} = require('./helpers.js');

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
test('B3: configuration errors name the site by ID or number without echoing values',async()=>{
 const tmp='C:/X';
 await assert.rejects(makeService({...slot(1,tmp),...slot(3,tmp,{APP_PASSWORD:''})})('list_sites'),e=>/Site website-3 requires/.test(e.message)&&!e.message.includes('user3'));
 await assert.rejects(makeService({WP_SITES_JSON:JSON.stringify([sites[0],{...sites[1],site_url:'http://b.example'}])})('list_sites'),e=>/Site site-b/.test(e.message)&&!e.message.includes('b.example'));
 await assert.rejects(makeService({WP_SITES_JSON:JSON.stringify([sites[0],{...sites[1],id:'Bad ID'}])})('list_sites'),e=>/Site number 2/.test(e.message)&&!e.message.includes('Bad ID'));
});
test('B6: manifest sites_json wording refers to earlier JSON setups, not v1.1.x',async()=>{
 const m=JSON.parse(await fs.readFile(path.join(__dirname,'../manifest.json'),'utf8'));
 assert.match(m.user_config.sites_json.description,/for users of earlier JSON setups/);assert.doesNotMatch(m.user_config.sites_json.description,/v1\.1\.x/);
});

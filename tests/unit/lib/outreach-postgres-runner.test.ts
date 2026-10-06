import { describe,it,expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync,mkdirSync,chmodSync,readFileSync,readdirSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const runner=path.resolve('scripts/test-outreach-postgres.mjs')
const fixtures={WINNR_TEST_DATABASE_URL:'winnr_test',OUTREACH_TEST_DATABASE_URL:'outreach_test',OUTREACH_CAMPAIGN_TEST_DATABASE_URL:'campaign_core_test',SUPPRESSION_TEST_DATABASE_URL:'coldforge_suppression_test',IDENTITY_TEST_DATABASE_URL:'coldforge_identity_test',WINNR_SMTP_TEST_DATABASE_URL:'winnr_smtp_test',EMAIL_DISPATCH_TEST_DATABASE_URL:'email_dispatch_test',WINNR_INGESTION_TEST_DATABASE_URL:'winnr_ingestion_test',LEAD_VALIDATION_TEST_DATABASE_URL:'coldforge_lead_validation_test',OUTREACH_CHAIN_TEST_DATABASE_URL:'coldforge_outreach_chain_test',OUTREACH_REPLIES_TEST_DATABASE_URL:'outreach_replies_test',OUTREACH_AGENTS_TEST_DATABASE_URL:'outreach_agents_test',OUTREACH_OPERATIONS_TEST_DATABASE_URL:'outreach_operations_test',OUTREACH_RECONCILIATION_TEST_DATABASE_URL:'outreach_reconciliation_test',OUTREACH_DOWNSTREAM_TEST_DATABASE_URL:'outreach_downstream_test',OUTREACH_MAIL_LOOP_TEST_DATABASE_URL:'outreach_mail_loop_test'}
const env=()=>({...process.env,...Object.fromEntries(Object.entries(fixtures).map(([key,db])=>[key,`postgres://127.0.0.1:55439/${db}`]))})
const check=(overrides:Record<string,string|undefined>={},cwd=process.cwd())=>spawnSync(process.execPath,[runner,'--check'],{env:{...env(),...overrides},cwd,encoding:'utf8'})
describe('required PostgreSQL release runner',()=>{
 it('checks all sixteen dedicated targets without opening a connection',()=>{const r=check();expect(r.status,r.stderr).toBe(0);expect(r.stdout).toContain('16 databases')})
 it.each(['OUTREACH_REPLIES_TEST_DATABASE_URL','OUTREACH_AGENTS_TEST_DATABASE_URL','OUTREACH_OPERATIONS_TEST_DATABASE_URL','OUTREACH_RECONCILIATION_TEST_DATABASE_URL','OUTREACH_DOWNSTREAM_TEST_DATABASE_URL','OUTREACH_MAIL_LOOP_TEST_DATABASE_URL'])('fails closed without %s',key=>{const r=check({[key]:undefined});expect(r.status).toBe(1);expect(r.stderr).toContain(`${key} is not set`)})
 it.each(['postgres://127.0.0.1:55439/postgres','postgres://other.invalid:55439/outreach_replies_test','postgres://127.0.0.1:55439/outreach_replies_test?host=other','postgres://127.0.0.1:55439/outreach_replies_test#other'])('rejects unsafe fixture %s',value=>expect(check({OUTREACH_REPLIES_TEST_DATABASE_URL:value}).status).toBe(1))
 it('CI has every URL, global role bootstrap, and one hard-required integration runner',()=>{const ci=readFileSync('.github/workflows/ci.yml','utf8');for(const [key,db]of Object.entries(fixtures)){expect(ci).toContain(`${key}: postgres://postgres:postgres@127.0.0.1:55439/${db}`);expect(ci).toContain(db)}expect(ci.indexOf('CREATE ROLE anon')).toBeLessThan(ci.indexOf('for db in'));expect(ci).toContain('node scripts/test-outreach-postgres.mjs --all-integration');expect(ci).not.toContain('run: npm run test:integration\n')})
 it.each(['034_future.sql','202610060001_future.sql'])('future migration %s cannot silently escape the release registry',future=>{const dir=mkdtempSync(path.join(tmpdir(),'outreach-registry-proof-'));try{mkdirSync(path.join(dir,'supabase/migrations'),{recursive:true});for(const file of readdirSync('supabase/migrations'))writeFileSync(path.join(dir,'supabase/migrations',file),'');writeFileSync(path.join(dir,'supabase/migrations',future),'');const r=check({},dir);expect(r.status).toBe(1);expect(r.stderr).toContain('Additive migration registry differs')}finally{rmSync(dir,{recursive:true,force:true})}})
 it.each(['pending','absent'])('fails if Vitest exits zero with required results %s, after serial role bootstrap',status=>{
  const dir=mkdtempSync(path.join(tmpdir(),'outreach-result-proof-'))
  try{
   const source=readFileSync(runner,'utf8');const suites=[...source.matchAll(/test: '([^']+)'/g)].map(match=>{if(!match[1])throw Error('Missing fixture suite path');return match[1]})
   mkdirSync(path.join(dir,'supabase/migrations'),{recursive:true});for(const file of readdirSync('supabase/migrations'))writeFileSync(path.join(dir,'supabase/migrations',file),'')
   for(const file of suites){mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});writeFileSync(path.join(dir,file),'')}
   const psql=path.join(dir,'fake-psql');writeFileSync(psql,`#!${process.execPath}
require('fs').writeFileSync(${JSON.stringify(path.join(dir,'roles-ready'))},'serial bootstrap');process.stdin.resume();`);chmodSync(psql,0o755)
   const vitest=path.join(dir,'node_modules/.bin/vitest');mkdirSync(path.dirname(vitest),{recursive:true});writeFileSync(vitest,`#!${process.execPath}
const fs=require('fs');if(!fs.existsSync(${JSON.stringify(path.join(dir,'roles-ready'))}))process.exit(9);const output=process.argv.find(arg=>arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);fs.writeFileSync(output,JSON.stringify({testResults:${JSON.stringify(status==='absent'?[]:suites.map(file=>({name:path.join(dir,file),assertionResults:[{status:'pending'}]})))}}));`);chmodSync(vitest,0o755)
   const result=spawnSync(process.execPath,[runner],{cwd:dir,env:{...env(),PSQL:psql},encoding:'utf8'})
   expect(result.status,result.stderr).toBe(1);expect(result.stderr).toContain('Required database coverage skipped or absent');expect(readFileSync(path.join(dir,'roles-ready'),'utf8')).toBe('serial bootstrap')
  }finally{rmSync(dir,{recursive:true,force:true})}
 })

})

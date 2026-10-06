/** Migration025 proof; the explicit dedicated fixture is the only permitted target. */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
const url = process.env.IDENTITY_TEST_DATABASE_URL
const PSQL = process.env.PSQL ?? 'psql'
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
function args() {
  if (!url) throw new Error('No explicit identity fixture URL')
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1' || parsed.port !== '55439' || parsed.pathname !== '/coldforge_identity_test' || parsed.search) throw new Error('Unsafe identity fixture URL')
  return ['-X','-v','ON_ERROR_STOP=1','--dbname',url,'-At']
}
function sql(statement: string) { return execFileSync(PSQL,args(),{input:statement,env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim() }
const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222', joined='33333333-3333-4333-8333-333333333333', org='44444444-4444-4444-8444-444444444444'
const bootstrap=(id:string)=>`SELECT organization_id||':'||role FROM public.bootstrap_email_identity('${id}','Synthetic organization');`
describe.skipIf(!url)('migration025 real identity contract',()=>{
 beforeAll(()=>{
  sql(`CREATE SCHEMA IF NOT EXISTS auth;
DROP FUNCTION IF EXISTS public.bootstrap_email_identity(uuid,text);
DROP TABLE IF EXISTS public.users,public.organizations,auth.users CASCADE;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb);
CREATE TABLE public.organizations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,slug text UNIQUE,plan text,settings jsonb);
CREATE TABLE public.users(id uuid PRIMARY KEY,organization_id uuid REFERENCES public.organizations,email text,full_name text,role text,settings jsonb,updated_at timestamptz);
INSERT INTO auth.users VALUES('${a}','fixture-a@example.com','{"role":"owner","organization_id":"attacker","full_name":"Display only"}'),('${b}','fixture-b@example.com','{}'),('${joined}','joined@example.com','{}');
INSERT INTO public.organizations VALUES('${org}','Existing','existing','starter','{}');
INSERT INTO public.users VALUES('${joined}','${org}','joined@example.com','Existing','member','{}',now());`)
  sql(readFileSync('supabase/migrations/025_identity_bootstrap.sql','utf8'))
 })
 it('uses stable auth email and never trusts metadata membership',()=>{
  expect(sql(bootstrap(a))).toMatch(/:owner$/)
  expect(sql(`SELECT email||':'||full_name FROM public.users WHERE id='${a}'`)).toBe('fixture-a@example.com:Display only')
 })
 it('is idempotent with no orphan organization',()=>{
  const before=sql('SELECT count(*) FROM public.organizations'); const first=sql(bootstrap(a));const second=sql(bootstrap(a));expect(first).toBe(second);expect(sql('SELECT count(*) FROM public.organizations')).toBe(before)
 })
 it('preserves existing tenant and member role',()=>{expect(sql(bootstrap(joined))).toBe(`${org}:member`)})
 it('concurrent first-user calls create exactly one organization',async()=>{
  const call=promisify(execFile)
  const results=await Promise.all([call(PSQL,[...args(),'-c',bootstrap(b)],{env}),call(PSQL,[...args(),'-c',bootstrap(b)],{env})])
  expect(results[0]?.stdout.trim()).toBe(results[1]?.stdout.trim())
  expect(sql(`SELECT count(*) FROM public.organizations WHERE slug='org-${b}'`)).toBe('1')
 })
 it('rejects unknown identities and preserves organization count',()=>{const count=sql('SELECT count(*) FROM public.organizations');expect(()=>sql(bootstrap('99999999-9999-4999-8999-999999999999'))).toThrow();expect(sql('SELECT count(*) FROM public.organizations')).toBe(count)})
 it('browser roles cannot execute arbitrary-user bootstrap',()=>{
  expect(()=>sql(`SET ROLE authenticated; ${bootstrap(a)}`)).toThrow()
  expect(()=>sql(`SET ROLE anon; ${bootstrap(a)}`)).toThrow()
  expect(sql("SELECT has_function_privilege('service_role','public.bootstrap_email_identity(uuid,text)','EXECUTE')")).toBe('t')
 })
 it('cannot choose an existing organization or role through RPC arguments',()=>{expect(()=>sql(`SELECT * FROM public.bootstrap_email_identity('${a}','Display','${org}','owner')`)).toThrow()})
})

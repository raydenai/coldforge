import {parse} from 'csv-parse/browser/esm/sync'
function isStringRow(row:unknown):row is string[]{return Array.isArray(row)&&row.every((cell:unknown)=>typeof cell==='string')}
export interface CsvRowIssue {record:number;email:string;reason:string}
export interface CsvLead {email:string;firstName?:string;lastName?:string;company?:string;title?:string;phone?:string}
/** Parse strictly before any import. Invalid email rows remain a reported partial import. */
export function parseLeadCsv(text:string):{leads:CsvLead[];skipped:number;issues:CsvRowIssue[]}{
 const rows:unknown=parse(text,{bom:true,skip_empty_lines:true,trim:true,max_record_size:100000})
 if(!Array.isArray(rows)||!rows.length)throw Error('CSV is empty')
 const records:string[][]=rows.map((row:unknown)=>{if(!isStringRow(row))throw Error('Invalid CSV');return row})
 const headers=records[0]!.map(h=>h.toLowerCase().trim().replace(/[\s_-]/g,''))
 const aliases={email:['email','emailaddress'],firstName:['first','firstname'],lastName:['last','lastname'],company:['company','companyname','organization'],title:['title','jobtitle','position'],phone:['phone','phonenumber','mobile','mobilenumber','telephone']}
 const indices:Record<string,number>=Object.fromEntries(Object.entries(aliases).map(([key,names])=>{const matches=headers.flatMap((h,i)=>names.includes(h)?[i]:[]);if(matches.length>1)throw Error(`CSV has ambiguous ${key} columns`);return[key,matches[0]??-1]}))
 if(indices.email===-1)throw Error('CSV must have an email column')
 const leads:CsvLead[]=[],issues:CsvRowIssue[]=[];let skipped=0
 for(const [recordIndex,values] of records.slice(1).entries()){if(values.length!==headers.length)throw Error('CSV row has a different number of columns');const email=values[indices.email!]??'';if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){skipped++;if(issues.length<100)issues.push({record:recordIndex+2,email:email.slice(0,320),reason:email?'Email address is invalid':'Email address is missing'});continue}const lead:CsvLead={email};for(const key of ['firstName','lastName','company','title','phone'] as const){const index=indices[key]!;if(index>=0)lead[key]=values[index]}leads.push(lead)}
 return{leads,skipped,issues}
}

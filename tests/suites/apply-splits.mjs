// Exercise api/apply-splits against a fake Supabase, checking the parts that
// would quietly corrupt a deck: ownership, malformed splits, and which row
// keeps its scheduling history.
import { readFileSync } from 'node:fs';
import { checker } from '../check.mjs';

const ck = checker();

const ME='user-me', THEM='user-them';
const ROWS = [
  { id:'r1', user_id:ME,   front:'les frais', back:'the costs; the expenses; fresh', category:'V', dates:['2025-05-01'], batch_id:'b1' },
  { id:'r2', user_id:THEM, front:'le voile',  back:'the veil; the sail',             category:'V', dates:[],            batch_id:null },
  { id:'r3', user_id:ME,   front:'le tour',   back:'the tour; the trick',            category:'V', dates:[],            batch_id:null },
];
let updates=[], inserted=[];
const fakeAdmin = {
  auth: { getUser: async (t) => t==='good' ? ({data:{user:{id:ME}}}) : ({error:{message:'bad'}}) },
  from() {
    const q = {
      _sel:null, _filters:{},
      select(){ return q; },
      in(col, vals){ q._rows = ROWS.filter(r=>vals.includes(r[col])); return Promise.resolve({data:q._rows}); },
      update(patch){ q._patch=patch; return q; },
      eq(col,val){ (q._filters[col]=val); if(col==='user_id'){ 
        if(q._filters.id){ const row=ROWS.find(r=>r.id===q._filters.id);
          if(!row||row.user_id!==val) return Promise.resolve({error:{message:'no row'}});
          updates.push({id:q._filters.id, ...q._patch}); return Promise.resolve({error:null}); }
      } return q; },
      insert(rows){ inserted.push(...rows); return { select: async () => ({data: rows.map((_,i)=>({id:'new'+i}))}) }; },
    };
    return q;
  },
};
globalThis.__fakeAdmin = fakeAdmin;

process.env.SUPABASE_URL='http://x';
process.env.SUPABASE_SERVICE_ROLE_KEY='k';

// Load the real handler with createClient swapped for the fake above, so the
// endpoint's own logic is what's under test.
const handlerSrc = readFileSync(new URL('../../api/apply-splits.js', import.meta.url), 'utf8')
  .replace('import { createClient } from "@supabase/supabase-js";',
           'const createClient = () => globalThis.__fakeAdmin;');
const mod = await import('data:text/javascript;base64,' + Buffer.from(handlerSrc).toString('base64'));
const handler = mod.default;

function mkRes(){ const r={code:null,body:null}; r.status=(c)=>{r.code=c;return r;}; r.json=(o)=>{r.body=o;return r;}; return r; }

console.log('\n  ownership');
let res = mkRes();
await handler({method:'POST', headers:{authorization:'Bearer good'}, body:{splits:[
  {row_id:'r2', cards:[{front:'le voile',back:'the veil',category:'vocab'},{front:'la voile',back:'the sail',category:'vocab'}]},
]}}, res);
ck('another user\'s card is refused', res.body?.updated===0 && res.body?.skipped?.[0]?.reason?.includes('not your card'),
   JSON.stringify(res.body));
ck('nothing was inserted for it', inserted.length===0, `${inserted.length}`);

console.log('\n  malformed splits');
updates=[]; inserted=[]; res=mkRes();
await handler({method:'POST', headers:{authorization:'Bearer good'}, body:{splits:[
  {row_id:'r1', cards:[{front:'les frais',back:'the costs',category:'vocab'}]},                       // only one card
  {row_id:'r3', cards:[{front:'le tour',back:'the tour',category:'vocab'},{front:'le tour',back:'the trick',category:'vocab'}]}, // duplicate fronts
]}}, res);
ck('a one-card "split" is refused', res.body?.skipped?.some(s=>s.row_id==='r1'), JSON.stringify(res.body?.skipped));
ck('duplicate fronts are refused', res.body?.skipped?.some(s=>s.row_id==='r3'));
ck('nothing written', updates.length===0 && inserted.length===0);

console.log('\n  the happy path');
updates=[]; inserted=[]; res=mkRes();
await handler({method:'POST', headers:{authorization:'Bearer good'}, body:{splits:[
  {row_id:'r1', cards:[
    {front:'les frais', back:'the costs / the expenses', category:'vocab'},
    {front:'frais (adj)', back:'fresh', category:'vocab'}]},
]}}, res);
ck('original row rewritten as the first sense', updates.length===1 && updates[0].id==='r1' && updates[0].back==='the costs / the expenses',
   JSON.stringify(updates));
ck('second sense inserted as a new card', inserted.length===1 && inserted[0].front==='frais (adj)', JSON.stringify(inserted.map(i=>i.front)));
ck('new card belongs to the caller', inserted[0]?.user_id===ME);
ck('new card inherits the lesson dates', JSON.stringify(inserted[0]?.dates)===JSON.stringify(['2025-05-01']));
ck('new card carries no scheduling history', !('stability' in inserted[0]) && !('next_due_at' in inserted[0]) && !('reps' in inserted[0]),
   Object.keys(inserted[0]||{}).join(','));
ck('category mapped back to a DB code', inserted[0]?.category==='V', inserted[0]?.category);
ck('reported honestly', res.body?.updated===1 && res.body?.inserted===1, JSON.stringify(res.body));

console.log('\n  bad token');
res=mkRes();
await handler({method:'POST', headers:{authorization:'Bearer nope'}, body:{splits:[{row_id:'r1',cards:[]}]}}, res);
ck('rejected', res.code===401, `${res.code}`);

const n = ck.fails();
console.log(n ? `\n  FAILED: ${n}` : '\n  all checks passed');
process.exit(n ? 1 : 0);

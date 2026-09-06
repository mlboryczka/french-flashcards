import http from 'http';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*','Access-Control-Expose-Headers':'*'};
const DAY=86400000, now=Date.now();
// A deck as it would look right after migration_006: seeded from Leitner boxes.
const deck=[
  {id:1,front:"une colline",back:"a hill",category:"V",dates:["2025-01-01","2025-06-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:21,difficulty:5,fsrs_state:2,reps:4,last_review:new Date(now-22*DAY).toISOString(),last_answer_correct:null},
  {id:2,front:"grimper",back:"to climb",category:"V",dates:[],flagged_for_review:false,batch_id:null,
   next_due_at:null,lapses:0,stability:null,difficulty:null,fsrs_state:0,reps:0,last_review:null,last_answer_correct:null},
  {id:3,front:"la moitié",back:"half",category:"V",dates:["2025-02-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-2*DAY).toISOString(),lapses:3,stability:2,difficulty:8,fsrs_state:2,reps:6,last_review:new Date(now-4*DAY).toISOString(),last_answer_correct:false},
  {id:4,front:"je suis allé (I went (passé)",back:"I went (passé composé)",category:"G",dates:["2025-03-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-3*DAY).toISOString(),lapses:1,stability:2,difficulty:6,fsrs_state:2,reps:3,last_review:new Date(now-5*DAY).toISOString(),last_answer_correct:true},
  {id:5,front:"au début",back:"at the beginning",category:"E",dates:["2025-04-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:8,difficulty:5,fsrs_state:2,reps:2,last_review:new Date(now-9*DAY).toISOString(),last_answer_correct:true},
  {id:6,front:"les frais",back:"the costs; the expenses; fresh",category:"V",dates:["2025-05-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:5,difficulty:5,fsrs_state:2,reps:2,last_review:new Date(now-6*DAY).toISOString(),last_answer_correct:true},
  {id:7,front:"le vélo",back:"the bike",category:"V",dates:["2025-06-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:6,difficulty:5,fsrs_state:2,reps:2,last_review:new Date(now-7*DAY).toISOString(),last_answer_correct:true},
  {id:8,front:"chercher",back:"to look for",category:"V",dates:["2025-06-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:6,difficulty:5,fsrs_state:2,reps:2,last_review:new Date(now-7*DAY).toISOString(),last_answer_correct:true},
  {id:9,front:"la fenêtre",back:"the window",category:"V",dates:["2025-06-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:6,difficulty:5,fsrs_state:2,reps:2,last_review:new Date(now-7*DAY).toISOString(),last_answer_correct:true},
  {id:10,front:"lentement",back:"slowly",category:"V",dates:["2025-06-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:6,difficulty:5,fsrs_state:2,reps:2,last_review:new Date(now-7*DAY).toISOString(),last_answer_correct:true},
  {id:11,front:"le bruit",back:"the noise",category:"V",dates:["2025-06-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:6,difficulty:5,fsrs_state:2,reps:2,last_review:new Date(now-7*DAY).toISOString(),last_answer_correct:true},
  {id:12,front:"ouvrir",back:"to open",category:"V",dates:["2025-06-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:6,difficulty:5,fsrs_state:2,reps:2,last_review:new Date(now-7*DAY).toISOString(),last_answer_correct:true},
  {id:13,front:"la patate douce",back:"the sweet potato",category:"V",dates:["2025-06-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:6,difficulty:5,fsrs_state:2,reps:2,last_review:new Date(now-7*DAY).toISOString(),last_answer_correct:true},
  {id:14,front:"le chemin de fer",back:"the railway",category:"V",dates:["2025-06-01"],flagged_for_review:false,batch_id:null,
   next_due_at:new Date(now-DAY).toISOString(),lapses:0,stability:6,difficulty:5,fsrs_state:2,reps:2,last_review:new Date(now-7*DAY).toISOString(),last_answer_correct:true},
];
http.createServer((req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,cors);return res.end();}
  let body=''; req.on('data',d=>body+=d);
  req.on('end',()=>{
    const j=(c,o)=>{res.writeHead(c,{...cors,'Content-Type':'application/json'});res.end(JSON.stringify(o));};
    if(req.method==='PATCH'&&req.url.includes('/rest/v1/user_cards')){
      console.log('[SCHEDULER WRITE]',req.url.split('?')[1]||'', body);
      return j(200,[]);
    }
    if(req.url.includes('/rest/v1/user_cards')&&req.method==='GET') return j(200,deck);
    if(req.url.includes('/rest/v1/')) return j(200,[]);
    j(200,{});
  });
}).listen(5999,()=>console.log('deck mock up'));

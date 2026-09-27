// Smoke test of the database stand-in through supabase-js, as the app and the
// API functions use it. Run against a fresh stand-in; wipe state afterwards.
import path from "node:path";
const WORK = process.env.WORK;
const { createClient } = await import(path.join(WORK, "app/node_modules/@supabase/supabase-js/dist/index.mjs")).catch(() => import(path.join(WORK, "app/node_modules/@supabase/supabase-js/dist/module/index.js")));
const URL_ = "http://127.0.0.1:5991";
const ok = (name, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);

// Magic link
let r = await fetch(`${URL_}/auth/v1/otp?redirect_to=${encodeURIComponent("http://127.0.0.1:5190")}`, { method: "POST", headers: { "content-type": "application/json", apikey: "stand-in" }, body: JSON.stringify({ email: "smoke@example.com", create_user: true }) });
ok("otp 200", r.status === 200);
const magic = await (await fetch(`${URL_}/__magic`)).json();
const link = magic.at(-1).link;
r = await fetch(link, { redirect: "manual" });
const loc = r.headers.get("location");
ok("verify redirects with tokens", r.status === 303 && /#access_token=.*refresh_token=.*token_type=bearer&type=magiclink/.test(loc), loc?.slice(0, 80));
const frag = new URLSearchParams(loc.split("#")[1]);
const at = frag.get("access_token");

const service = createClient(URL_, "stand-in", { auth: { persistSession: false, autoRefreshToken: false } });
const { data: u, error: ue } = await service.auth.getUser(at);
ok("getUser via service client", !ue && u?.user?.email === "smoke@example.com", ue?.message);
const uid = u.user.id;

const user = createClient(URL_, "stand-in", { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${at}` } } });
// Insert via upsert (like the commit), count exact
let res = await service.from("user_cards").upsert([
  { user_id: uid, front: "un chat", back: "a cat", category: "V", dates: ["2025-06-01"], source: "cahier-upload", batch_id: null },
  { user_id: uid, front: "un chien", back: "a dog", category: "V", dates: ["2025-06-01", "2025-07-01"], source: "cahier-upload", batch_id: null },
], { onConflict: "user_id,front", count: "exact" });
ok("bulk upsert count", !res.error && res.count === 2, JSON.stringify(res.error));
// Re-upsert with changed back: merge, no new row
res = await service.from("user_cards").upsert([{ user_id: uid, front: "un chat", back: "a cat (pet)", category: "V", dates: ["2025-06-01"], source: "cahier-upload", batch_id: null }], { onConflict: "user_id,front", count: "exact" });
let all = await user.from("user_cards").select("id, front, back, next_due_at, fsrs_state, en_fsrs_state, stability").eq("user_id", uid).order("id", { ascending: true }).range(0, 999);
ok("user sees 2 rows, merged back", all.data?.length === 2 && all.data[0].back === "a cat (pet)", JSON.stringify(all.error || all.data?.map((x) => x.back)));
ok("defaults applied", all.data?.[0].fsrs_state === 0 && all.data?.[0].en_fsrs_state === 0 && /\+00:00$/.test(all.data?.[0].next_due_at), JSON.stringify(all.data?.[0]));
const id1 = all.data[0].id;
// Update FSRS state with a double; read back float4
res = await user.from("user_cards").update({ stability: 2.3065123456789, difficulty: 2.118104, fsrs_state: 2, reps: 1, next_due_at: "2026-09-28T22:00:05.123Z", last_review: "2026-09-25T22:00:05.123Z", last_answer_correct: true }).eq("id", id1);
ok("update ok", !res.error, JSON.stringify(res.error));
all = await user.from("user_cards").select("stability, difficulty, next_due_at, last_review").eq("id", id1).single();
ok("float4 readback + ts format", all.data?.stability === 2.3065124 && all.data?.next_due_at === "2026-09-28T22:00:05.123+00:00", JSON.stringify(all.data));
// NOT NULL violation
res = await user.from("user_cards").update({ next_due_at: null }).eq("id", id1);
ok("not-null refused", res.error?.code === "23502" && res.status === 400, JSON.stringify(res.error));
// CHECK violation
res = await user.from("user_cards").update({ fsrs_state: 7 }).eq("id", id1);
ok("check refused", res.error?.code === "23514", JSON.stringify(res.error));
// Unknown column
res = await user.from("user_cards").update({ nonsense: 1 }).eq("id", id1);
ok("unknown column refused", res.error?.code === "PGRST204", JSON.stringify(res.error));
// card_reviews upsert on id (twice = one row)
const rid = crypto.randomUUID();
const row = { id: rid, user_id: uid, card_id: id1, direction: "fr", answered_at: "2026-09-25T22:00:05.123Z", correct: true, counted: true, rating: 3, state_before: 0, stability_before: null, difficulty_before: null, last_review_before: null, stability_after: 2.3065, difficulty_after: 2.1181, due_after: "2026-09-28T22:00:05.123Z" };
res = await user.from("card_reviews").upsert(row, { onConflict: "id" });
ok("review upsert", !res.error, JSON.stringify(res.error));
res = await user.from("card_reviews").upsert({ ...row, correct: false, rating: 1 }, { onConflict: "id" });
const cnt = await (await fetch(`${URL_}/__count/card_reviews`)).json();
ok("review upsert same id = one row", cnt.count === 1 && !res.error);
// FK violation
res = await user.from("card_reviews").upsert({ ...row, id: crypto.randomUUID(), card_id: 999999 }, { onConflict: "id" });
ok("fk refused", res.error?.code === "23503", JSON.stringify(res.error));
// review dates ignore duplicates
res = await user.from("user_review_dates").upsert({ user_id: uid, review_date: "2026-09-25" }, { onConflict: "user_id,review_date", ignoreDuplicates: true });
const res2 = await user.from("user_review_dates").upsert({ user_id: uid, review_date: "2026-09-25" }, { onConflict: "user_id,review_date", ignoreDuplicates: true });
const dates = await user.from("user_review_dates").select("review_date").eq("user_id", uid).order("review_date", { ascending: false }).limit(400);
ok("review dates idempotent", !res.error && !res2.error && dates.data?.length === 1 && dates.data[0].review_date === "2026-09-25", JSON.stringify([res.error, res2.error, dates.data]));
// maybeSingle on empty
const link2 = await user.from("cahier_links").select("*").eq("user_id", uid).maybeSingle();
ok("maybeSingle empty → null", !link2.error && link2.data === null, JSON.stringify(link2));
// RLS: insert for another user refused
res = await user.from("card_progress").upsert({ user_id: "00000000-0000-0000-0000-000000000009", card_id: "x", score: 1, seen: 1, got: 1 }, { onConflict: "user_id,card_id" });
ok("rls insert refused", res.error?.code === "42501", JSON.stringify(res.error));
// insert ... select single (cahier-parse batch)
const b = await service.from("upload_batches").insert({ user_id: uid, source: "file", input_chars: 10, few_shot_correction_ids: [], model: "m" }).select("id").single();
ok("insert select single", !b.error && /^[0-9a-f-]{36}$/.test(b.data?.id), JSON.stringify(b));
// parse_corrections read by service with filters
const pc = await service.from("parse_corrections").select("id, category").eq("promoted_to_rule", false).order("created_at", { ascending: false }).limit(50);
ok("parse_corrections empty", !pc.error && pc.data.length === 0, JSON.stringify(pc.error));
// in / or filters
const inq = await user.from("user_cards").select("front").in("front", ["un chat", "un chien"]).or("fsrs_state.eq.2,front.eq.un chien");
ok("in + or filters", !inq.error && inq.data.length === 2, JSON.stringify(inq));
// delete cascade
res = await user.from("user_cards").delete().in("id", [id1]).eq("user_id", uid);
const cnt2 = await (await fetch(`${URL_}/__count/card_reviews`)).json();
ok("delete cascades reviews", !res.error && cnt2.count === 0, JSON.stringify(res.error));
// refresh token
r = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { "content-type": "application/json", apikey: "stand-in" }, body: JSON.stringify({ refresh_token: frag.get("refresh_token") }) });
const sess = await r.json();
ok("refresh", r.status === 200 && sess.access_token && sess.expires_in > 1e8 && !("expires_at" in sess));

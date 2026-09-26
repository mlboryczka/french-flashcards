// "How much to remember": the student's one FSRS setting, and the daily check
// behind it (useFsrsSettings). Judged by what is written to fsrs_settings and
// sent to /api/fsrs-fit, not by what the dialog says.
import { openApp, finish, checker } from "../harness.mjs";

const ck = checker();
const CORS = { "access-control-allow-origin": "*" };
// The student's day, 4am to 4am (lib/studyDay.js).
const studyDay = (t = Date.now()) => {
  const d = new Date(t);
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function open({ table = true, row = null } = {}) {
  const saves = [];
  const fits = [];
  let current = row;
  const { browser, page } = await openApp({
    route: async (p) => {
      await p.route("**/rest/v1/fsrs_settings*", async (r) => {
        const method = r.request().method();
        if (!table) {
          return r.fulfill({ status: 404, contentType: "application/json", headers: CORS, body: JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.fsrs_settings' in the schema cache" }) });
        }
        if (method === "GET") {
          return r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(current ? [current] : []) });
        }
        if (method === "POST") {
          const body = JSON.parse(r.request().postData() || "{}");
          saves.push(body);
          current = { target_mode: "auto", target: 0.9, days: [], ...(current || {}), ...body };
          return r.fulfill({ status: 201, contentType: "application/json", headers: CORS, body: JSON.stringify([current]) });
        }
        return r.continue();
      });
      await p.route("**/api/fsrs-fit", async (r) => {
        fits.push(JSON.parse(r.request().postData() || "{}"));
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "waiting", answers: 420, needed: 1000, recomputed: 0 }) });
      });
    },
  });
  await page.waitForTimeout(1500);
  const openDialog = async () => {
    await page.locator("[data-sidebar] button", { hasText: /^[A-Z]$/ }).click();
    await page.waitForTimeout(200);
    await page.locator("[data-fsrs-settings-toggle]").click();
    await page.waitForSelector("[data-fsrs-settings]", { timeout: 5000 });
  };
  const checked = () => page.evaluate(() => document.querySelector('[data-fsrs-settings] [aria-checked="true"]')?.dataset.choice || null);
  return { browser, page, saves, fits, openDialog, checked };
}

console.log("\n  once a study day: the day is recorded and the server is asked");
{
  const t = await open();
  const day = t.saves.find((s) => Array.isArray(s.days));
  ck("the day is recorded, under the student's own date", day && day.days.length === 1 && day.days[0].date === studyDay(), JSON.stringify(day));
  ck("with whether it began with due cards left over", typeof day?.days[0].behind === "boolean", JSON.stringify(day?.days));
  ck("the server is asked once, with the student's time zone",
     t.fits.length === 1 && t.fits[0].timeZone === Intl.DateTimeFormat().resolvedOptions().timeZone, JSON.stringify(t.fits));

  console.log("\n  the setting");
  await t.openDialog();
  ck("four choices, and a new student is on Automatic", (await t.page.locator("[data-fsrs-settings] [role=radio]").count()) === 4 && (await t.checked()) === "auto");
  ck("it says how many answers there are so far", /420 so far/.test(await t.page.locator("[data-fsrs-settings]").innerText()));
  await t.page.locator('[data-choice="more"]').click();
  await t.page.waitForTimeout(400);
  const more = t.saves.at(-1);
  ck("Remember more saves a fixed 95%", more?.target_mode === "fixed" && more?.target === 0.95, JSON.stringify(more));
  ck("and shows as chosen", (await t.checked()) === "more");
  await t.page.locator('[data-choice="auto"]').click();
  await t.page.waitForTimeout(400);
  const auto = t.saves.at(-1);
  ck("Automatic goes back to 90%, automatic", auto?.target_mode === "auto" && auto?.target === 0.9, JSON.stringify(auto));

  console.log("\n  not twice in a day");
  const before = { saves: t.saves.length, fits: t.fits.length };
  await t.page.reload({ waitUntil: "commit" });
  await t.page.waitForSelector('button:has-text("Previous card")', { timeout: 20000 });
  await t.page.waitForTimeout(1500);
  ck("a second open the same day records nothing and asks nothing",
     t.saves.length === before.saves && t.fits.length === before.fits, `${t.saves.length - before.saves} saves, ${t.fits.length - before.fits} fits`);
  await t.browser.close();
}

console.log("\n  before migration_012");
{
  const t = await open({ table: false });
  ck("nothing is written and the server isn't asked", t.saves.length === 0 && t.fits.length === 0, `${t.saves.length} saves, ${t.fits.length} fits`);
  await t.openDialog();
  ck("the dialog says the standard settings are in use", /standard settings/.test(await t.page.locator("[data-fsrs-settings]").innerText()));
  await t.browser.close();
}

await finish(null, ck);

// Throwaway: what context does the tutor actually get, from each way in?
import { createServer } from "node:http";
import { openApp } from "../harness.mjs";

const seen = [];
const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"*","Access-Control-Allow-Methods":"*"});
    return res.end();
  }
  let body = ""; for await (const c of req) body += c;
  seen.push(JSON.parse(body || "{}"));
  res.writeHead(200, {"Content-Type":"text/event-stream","Access-Control-Allow-Origin":"*"});
  res.write(`data: ${JSON.stringify({type:"text",delta:"ok"})}\n\n`);
  res.write(`data: ${JSON.stringify({type:"done"})}\n\n`);
  res.end();
});
await new Promise(r => server.listen(0,"127.0.0.1",r));
const PORT = server.address().port;

const { browser, page } = await openApp({
  route: async (p) => { await p.route("**/api/chat", r => r.continue({ url:`http://127.0.0.1:${PORT}/chat` })); },
});

async function ask(label) {
  await page.waitForSelector("textarea[placeholder*='Ask about']", { timeout: 8000 });
  const sub = await page.evaluate(() => {
    const t = [...document.querySelectorAll("div")].find(d => /^(Looking at:|Look something up)/.test(d.textContent.trim()));
    return t ? t.textContent.trim().slice(0, 60) : "(no subtitle)";
  });
  await page.fill("textarea[placeholder*='Ask about']", "what is this");
  await page.click("button:text-is('Send')");
  await page.waitForTimeout(900);
  const ctx = seen[seen.length-1]?.context;
  console.log(`\n[${label}]`);
  console.log("  subtitle:", sub);
  console.log("  currentCard:", ctx?.currentCard ? `${ctx.currentCard.front} (missed=${ctx.currentCard.missed})` : "NONE");
  console.log("  relatedCards:", ctx?.relatedCards?.length ?? 0, " recentMisses:", ctx?.recentMisses?.length ?? 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

// 1. nav, while studying
await page.click("[data-tutor-toggle]");
await ask("nav, study mode");

// 2. Cards view
await page.evaluate(() => {
  const n = [...document.querySelectorAll("aside *")].filter(x => x.textContent.trim() === "Cards").pop();
  for (let el = n; el; el = el.parentElement) { el.click(); if (!/Tap to reveal/.test(document.body.innerText)) return; }
});
await page.waitForTimeout(600);
await page.click("[data-tutor-toggle]");
await ask("nav, Cards view");

console.log("\nrequests captured:", seen.length);
server.close(); await browser.close();

import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const SEEN_PATH        = path.resolve("seen_jobs.json");
const COMPANIES_PATH   = path.resolve("companies.json");

/** Polite delay between company fetches — avoids rate limits */
const INTER_FETCH_DELAY_MS = 1000;

/** Telegram message hard limit */
const TELEGRAM_MAX_CHARS = 4096;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * companies.json shape.
 *
 * `ats`      — which ATS to hit ("greenhouse" | "lever")
 * `slug`     — board token / company slug for that ATS
 * `linkedin` — optional fallback LinkedIn company ID or slug
 */
interface Company {
  name: string;
  ats: "greenhouse" | "lever";
  slug: string;
  linkedin?: string;
}

interface Job {
  id: string; // prefixed: "gh_" | "lv_" | "li_"
  title: string;
  location: string;
  url: string;
  source: "greenhouse" | "lever" | "linkedin";
}

type FetchResult =
  | { ok: true;  jobs: Job[] }
  | { ok: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

function loadSeen(): Set<string> {
  if (!fs.existsSync(SEEN_PATH)) return new Set();
  try {
    const raw = fs.readFileSync(SEEN_PATH, "utf-8").trim();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    console.warn("⚠️  seen_jobs.json is corrupt — starting fresh.");
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen], null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-side filtering
// Neither API supports server-side keyword/geo filtering on public endpoints.
// ─────────────────────────────────────────────────────────────────────────────

const ENTRY_KEYWORDS = [
  "intern", "internship",
  "junior", "jr.",
  "associate",
  "entry level", "entry-level",
  "fresher", "graduate", "new grad",
  "software engineer",
  "sde", "sde-1", "sde 1", "sde i",
  "swe", "swe-1", "swe 1", "swe i",
  "backend engineer", "frontend engineer",
  "full stack engineer", "full-stack engineer",
];

const INDIA_KEYWORDS = [
  "india", "bangalore", "bengaluru", "mumbai", "hyderabad",
  "pune", "delhi", "noida", "gurugram", "gurgaon", "chennai",
  "kolkata", "remote",
];

function isEntryLevel(title: string): boolean {
  const t = title.toLowerCase();
  return ENTRY_KEYWORDS.some((kw) => t.includes(kw));
}

function isIndia(location: string): boolean {
  const l = location.toLowerCase();
  return INDIA_KEYWORDS.some((kw) => l.includes(kw));
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

async function safeFetch(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json, text/html, */*",
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`    HTTP ${res.status} → ${url}`);
      return null;
    }
    return res;
  } catch (err: any) {
    clearTimeout(timer);
    console.warn(`    Network/timeout → ${url}: ${err?.message ?? err}`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Source: Greenhouse
// GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
// Public — no auth required.
// ─────────────────────────────────────────────────────────────────────────────

interface GHJob {
  id: number;
  title: string;
  location?: { name?: string };
  absolute_url: string;
}

async function fetchGreenhouse(slug: string): Promise<FetchResult> {
  const res = await safeFetch(
    `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`
  );
  if (!res) return { ok: false, reason: "fetch failed" };

  let data: { jobs?: GHJob[] };
  try { data = await res.json(); }
  catch { return { ok: false, reason: "JSON parse error" }; }

  if (!Array.isArray(data.jobs))
    return { ok: false, reason: "unexpected shape — missing jobs[]" };

  const jobs: Job[] = data.jobs
    .filter((j) => isEntryLevel(j.title) && isIndia(j.location?.name ?? ""))
    .map((j) => ({
      id:       `gh_${j.id}`,
      title:    j.title.trim(),
      location: (j.location?.name ?? "Not specified").trim(),
      url:      j.absolute_url,
      source:   "greenhouse" as const,
    }));

  return { ok: true, jobs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source: Lever
// GET https://api.lever.co/v0/postings/{slug}?mode=json
// Public — no auth required.
// ─────────────────────────────────────────────────────────────────────────────

interface LVJob {
  id: string;
  text: string;
  categories?: { location?: string };
  hostedUrl: string;
}

async function fetchLever(slug: string): Promise<FetchResult> {
  const res = await safeFetch(
    `https://api.lever.co/v0/postings/${slug}?mode=json`
  );
  if (!res) return { ok: false, reason: "fetch failed" };

  let data: LVJob[];
  try { data = await res.json(); }
  catch { return { ok: false, reason: "JSON parse error" }; }

  if (!Array.isArray(data))
    return { ok: false, reason: "unexpected shape — expected array" };

  const jobs: Job[] = data
    .filter((j) => isEntryLevel(j.text) && isIndia(j.categories?.location ?? ""))
    .map((j) => ({
      id:       `lv_${j.id}`,
      title:    j.text.trim(),
      location: (j.categories?.location ?? "Not specified").trim(),
      url:      j.hostedUrl,
      source:   "lever" as const,
    }));

  return { ok: true, jobs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source: LinkedIn (fallback scraper)
// Unauthenticated guest job feed — last resort, may break on HTML changes.
// f_E=1%2C2 → Experience filter: 1=Internship, 2=Entry Level
// ─────────────────────────────────────────────────────────────────────────────

async function fetchLinkedIn(linkedinId: string): Promise<FetchResult> {
  const url =
    `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` +
    `?keywords=software%20engineer&location=India` +
    `&f_E=1%2C2&f_C=${linkedinId}&start=0`;

  const res = await safeFetch(url);
  if (!res) return { ok: false, reason: "fetch failed" };

  const html = await res.text();
  const jobs: Job[] = [];

  const re =
    /data-entity-urn="urn:li:jobPosting:(\d+)"[\s\S]*?class="base-search-card__title"[^>]*>\s*([^<]+?)\s*<[\s\S]*?class="job-search-card__location"[^>]*>\s*([^<]+?)\s*</g;

  for (const m of html.matchAll(re)) {
    jobs.push({
      id:       `li_${m[1]}`,
      title:    m[2].trim(),
      location: m[3].trim(),
      url:      `https://www.linkedin.com/jobs/view/${m[1]}`,
      source:   "linkedin" as const,
    });
  }

  return { ok: true, jobs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// Primary = whichever ATS is declared in companies.json
// Fallback = LinkedIn (only if `linkedin` field is present)
//
// NOTE: If primary returns ok:true with 0 jobs, we do NOT fall through.
//       Zero results from a working API is valid — not an error.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_TAG: Record<string, string> = {
  greenhouse: "GH",
  lever:      "LV",
  linkedin:   "LI",
};

async function fetchCompany(company: Company): Promise<Job[]> {
  const primary =
    company.ats === "greenhouse"
      ? await fetchGreenhouse(company.slug)
      : await fetchLever(company.slug);

  if (primary.ok) {
    console.log(
      `  [${SOURCE_TAG[company.ats]}] ${company.name}: ${primary.jobs.length} relevant job(s)`
    );
    return primary.jobs;
  }

  console.warn(
    `  [${SOURCE_TAG[company.ats]}] ${company.name}: failed — ${primary.reason}`
  );

  if (!company.linkedin) {
    console.log(`  [LI] ${company.name}: no linkedin id — skipping fallback`);
    return [];
  }

  const fallback = await fetchLinkedIn(company.linkedin);
  if (fallback.ok) {
    console.log(`  [LI] ${company.name}: ${fallback.jobs.length} relevant job(s)`);
    return fallback.jobs;
  }

  console.warn(`  [LI] ${company.name}: also failed — ${fallback.reason}`);
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram
// Sends one message per company, chunks if > 4096 chars.
// ─────────────────────────────────────────────────────────────────────────────

async function sendTelegram(text: string): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:                  TELEGRAM_CHAT_ID,
        text,
        parse_mode:               "HTML",
        disable_web_page_preview: true,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`  Telegram ${res.status}: ${body}`);
  }
}

async function sendCompanyAlert(companyName: string, jobs: Job[]): Promise<void> {
  const lines = jobs.map(
    (j) => `  • <a href="${j.url}">${j.title}</a> — ${j.location}`
  );

  const headerFirst    = `🚨 <b>${companyName}</b> — ${jobs.length} new role(s)\n\n`;
  const headerContinue = `📋 <b>${companyName}</b> (continued)\n\n`;

  let isFirst   = true;
  let chunk:     string[] = [];
  let chunkSize: number   = headerFirst.length;

  const flush = async () => {
    const header = isFirst ? headerFirst : headerContinue;
    await sendTelegram(header + chunk.join("\n"));
    isFirst   = false;
    chunk     = [];
    chunkSize = headerContinue.length;
  };

  for (const line of lines) {
    const lineBytes = line.length + 1; // +1 for "\n"
    if (chunkSize + lineBytes > TELEGRAM_MAX_CHARS) await flush();
    chunk.push(line);
    chunkSize += lineBytes;
  }

  if (chunk.length > 0) await flush();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌  Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID env vars.");
    process.exit(1);
  }

  const companies: Company[] = JSON.parse(
    fs.readFileSync(COMPANIES_PATH, "utf-8")
  );

  const seen       = loadSeen();
  const newJobsMap = new Map<string, Job[]>(); // companyName → new jobs

  console.log(`\n🔍 Scanning ${companies.length} companies…\n`);

  for (const company of companies) {
    const jobs = await fetchCompany(company);

    for (const job of jobs) {
      if (!seen.has(job.id)) {
        seen.add(job.id);
        if (!newJobsMap.has(company.name)) newJobsMap.set(company.name, []);
        newJobsMap.get(company.name)!.push(job);
      }
    }

    await sleep(INTER_FETCH_DELAY_MS);
  }

  // Persist immediately — even if Telegram fails, we won't re-alert
  saveSeen(seen);

  const totalNew = [...newJobsMap.values()].reduce((s, a) => s + a.length, 0);

  if (totalNew === 0) {
    console.log("\n✅ No new jobs found.");
    return;
  }

  console.log(`\n📬 Sending alerts for ${totalNew} new job(s)…\n`);

  for (const [companyName, jobs] of newJobsMap) {
    await sendCompanyAlert(companyName, jobs);
    console.log(`  ✓ ${companyName}: ${jobs.length} job(s) sent`);
  }

  console.log(`\n✅ Done. ${totalNew} total new jobs.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
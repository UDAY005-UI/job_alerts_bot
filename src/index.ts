import fs from "fs";
import path from "path";

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const SEEN_PATH        = path.resolve("seen_jobs.json");
const COMPANIES_PATH   = path.resolve("companies.json");

const INTER_FETCH_DELAY_MS = 1000;
const TELEGRAM_MAX_CHARS   = 4000; // safe margin under 4096

// ── Types ─────────────────────────────────────────────────────────────────────

interface Company {
  name: string;
  ats: "greenhouse" | "lever";
  slug: string;
  linkedin?: string;
}

interface Job {
  id: string;
  title: string;
  location: string;
  url: string;
  source: "greenhouse" | "lever" | "linkedin";
}

type FetchResult =
  | { ok: true;  jobs: Job[] }
  | { ok: false; reason: string };

// ── Persistence ───────────────────────────────────────────────────────────────

function loadSeen(): Set<string> {
  if (!fs.existsSync(SEEN_PATH)) return new Set();
  try {
    const raw = fs.readFileSync(SEEN_PATH, "utf-8").trim();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    console.warn("seen_jobs.json corrupt — starting fresh.");
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen], null, 2));
}

// ── Filtering ─────────────────────────────────────────────────────────────────

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
  "kolkata", "lucknow", "remote",
];

const isEntryLevel = (title: string)    => ENTRY_KEYWORDS.some(kw => title.toLowerCase().includes(kw));
const isIndia      = (location: string) => INDIA_KEYWORDS.some(kw => location.toLowerCase().includes(kw));

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function safeFetch(url: string): Promise<Response | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "Accept":     "application/json, text/html, */*",
      },
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`  HTTP ${res.status} -> ${url}`); return null; }
    return res;
  } catch (e: any) {
    clearTimeout(timer);
    console.warn(`  Fetch error -> ${url}: ${e?.message ?? e}`);
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Greenhouse ────────────────────────────────────────────────────────────────

interface GHJob {
  id: number;
  title: string;
  location?: { name?: string };
  absolute_url: string;
}

async function fetchGreenhouse(slug: string): Promise<FetchResult> {
  const res = await safeFetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  if (!res) return { ok: false, reason: "fetch failed" };

  let data: { jobs?: GHJob[] };
  try { data = await res.json(); } catch { return { ok: false, reason: "JSON parse error" }; }
  if (!Array.isArray(data.jobs)) return { ok: false, reason: "missing jobs[]" };

  const jobs: Job[] = data.jobs
    .filter(j => isEntryLevel(j.title) && isIndia(j.location?.name ?? ""))
    .map(j => ({
      id:       "gh_" + j.id,
      title:    j.title.trim(),
      location: (j.location?.name ?? "Not specified").trim(),
      url:      j.absolute_url,
      source:   "greenhouse" as const,
    }));

  return { ok: true, jobs };
}

// ── Lever ─────────────────────────────────────────────────────────────────────

interface LVJob {
  id: string;
  text: string;
  categories?: { location?: string };
  hostedUrl: string;
}

async function fetchLever(slug: string): Promise<FetchResult> {
  const res = await safeFetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!res) return { ok: false, reason: "fetch failed" };

  let data: LVJob[];
  try { data = await res.json(); } catch { return { ok: false, reason: "JSON parse error" }; }
  if (!Array.isArray(data)) return { ok: false, reason: "expected array" };

  const jobs: Job[] = data
    .filter(j => isEntryLevel(j.text) && isIndia(j.categories?.location ?? ""))
    .map(j => ({
      id:       "lv_" + j.id,
      title:    j.text.trim(),
      location: (j.categories?.location ?? "Not specified").trim(),
      url:      j.hostedUrl,
      source:   "lever" as const,
    }));

  return { ok: true, jobs };
}

// ── LinkedIn fallback ─────────────────────────────────────────────────────────

async function fetchLinkedIn(linkedinId: string): Promise<FetchResult> {
  const url =
    "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search" +
    "?keywords=software%20engineer&location=India&f_E=1%2C2" +
    "&f_C=" + linkedinId + "&start=0";

  const res = await safeFetch(url);
  if (!res) return { ok: false, reason: "fetch failed" };

  const html = await res.text();
  const jobs: Job[] = [];
  const re = /data-entity-urn="urn:li:jobPosting:(\d+)"[\s\S]*?class="base-search-card__title"[^>]*>\s*([^<]+?)\s*<[\s\S]*?class="job-search-card__location"[^>]*>\s*([^<]+?)\s*</g;

  for (const m of html.matchAll(re)) {
    jobs.push({
      id:       "li_" + m[1],
      title:    m[2].trim(),
      location: m[3].trim(),
      url:      "https://www.linkedin.com/jobs/view/" + m[1],
      source:   "linkedin" as const,
    });
  }

  return { ok: true, jobs };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function fetchCompany(company: Company): Promise<Job[]> {
  const label   = company.ats === "greenhouse" ? "GH" : "LV";
  const primary = company.ats === "greenhouse"
    ? await fetchGreenhouse(company.slug)
    : await fetchLever(company.slug);

  if (primary.ok) {
    console.log(`  [${label}] ${company.name}: ${primary.jobs.length} relevant job(s)`);
    return primary.jobs;
  }

  console.warn(`  [${label}] ${company.name}: failed -- ${primary.reason}`);

  if (!company.linkedin) {
    console.log(`  [LI] ${company.name}: no linkedin id, skipping fallback`);
    return [];
  }

  const fallback = await fetchLinkedIn(company.linkedin);
  if (fallback.ok) {
    console.log(`  [LI] ${company.name}: ${fallback.jobs.length} relevant job(s)`);
    return fallback.jobs;
  }

  console.warn(`  [LI] ${company.name}: also failed -- ${fallback.reason}`);
  return [];
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(text: string): Promise<void> {
  const res = await fetch(
    "https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage",
    {
      method:  "POST",
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
    console.error("  Telegram " + res.status + ": " + body);
  }
}

/**
 * Sends alert for one company, splitting into multiple Telegram messages
 * if total length exceeds TELEGRAM_MAX_CHARS.
 *
 * Message format:
 *   🚨 <b>CompanyName</b> — N new role(s)
 *
 *   • <a href="...">Title</a> — Location
 *   • ...
 */
async function sendCompanyAlert(companyName: string, jobs: Job[]): Promise<void> {
  // Build each bullet line
  const lines = jobs.map(j =>
    "  \u2022 <a href=\"" + j.url + "\">" + j.title + "</a> \u2014 " + j.location
  );

  // Headers — constructed with string concat to avoid any escaping issues
  const makeHeader = (isFirst: boolean) =>
    isFirst
      ? "\uD83D\uDEA8 <b>" + companyName + "</b> \u2014 " + jobs.length + " new role(s)\n\n"
      : "\uD83D\uDCCB <b>" + companyName + "</b> (continued)\n\n";

  let pageIndex = 0;
  let chunk: string[] = [];
  let chunkLen = makeHeader(true).length;

  const flush = async () => {
    const header = makeHeader(pageIndex === 0);
    const body   = chunk.join("\n");
    await sendTelegram(header + body);
    pageIndex++;
    chunk    = [];
    chunkLen = makeHeader(false).length;
  };

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for \n separator
    if (chunkLen + lineLen > TELEGRAM_MAX_CHARS) {
      await flush();
    }
    chunk.push(line);
    chunkLen += lineLen;
  }

  if (chunk.length > 0) await flush();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID env vars.");
    process.exit(1);
  }

  const companies: Company[] = JSON.parse(fs.readFileSync(COMPANIES_PATH, "utf-8"));
  const seen       = loadSeen();
  const newJobsMap = new Map<string, Job[]>();

  console.log("\nScanning " + companies.length + " companies...\n");

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

  // Save before sending — if Telegram fails we won't re-alert next run
  saveSeen(seen);

  const totalNew = [...newJobsMap.values()].reduce((s, a) => s + a.length, 0);
  if (totalNew === 0) {
    console.log("\nNo new jobs found.");
    return;
  }

  console.log("\nSending alerts for " + totalNew + " new job(s)...\n");

  for (const [companyName, jobs] of newJobsMap) {
    await sendCompanyAlert(companyName, jobs);
    console.log("  Sent: " + companyName + " (" + jobs.length + " job(s))");
  }

  console.log("\nDone. " + totalNew + " total new jobs.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
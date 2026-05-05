import fs from "fs";
import path from "path";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const SEEN_PATH = path.resolve("seen_jobs.json");

interface Company {
  name: string;
  ats: "greenhouse" | "lever";
  slug: string;
}

interface Job {
  id: string;
  title: string;
  location: string;
  url: string;
}

function loadSeen(): Set<string> {
  if (!fs.existsSync(SEEN_PATH)) return new Set();
  const data = JSON.parse(fs.readFileSync(SEEN_PATH, "utf-8"));
  return new Set(data);
}

function saveSeen(seen: Set<string>) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen], null, 2));
}

async function fetchGreenhouse(slug: string): Promise<Job[]> {
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`
  );
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data.jobs || []).map((j: any) => ({
    id: `gh_${j.id}`,
    title: j.title,
    location: j.location?.name || "Remote",
    url: j.absolute_url,
  }));
}

async function fetchLever(slug: string): Promise<Job[]> {
  const res = await fetch(
    `https://api.lever.co/v0/postings/${slug}?mode=json`
  );
  if (!res.ok) return [];
  const data = await res.json() as any[];
  return data.map((j: any) => ({
    id: `lv_${j.id}`,
    title: j.text,
    location: j.categories?.location || "Remote",
    url: j.hostedUrl,
  }));
}

async function sendTelegram(message: string) {
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }
  );
}

async function main() {
  const companies: Company[] = JSON.parse(
    fs.readFileSync("companies.json", "utf-8")
  );
  const seen = loadSeen();
  const newJobs: { company: string; job: Job }[] = [];

  for (const company of companies) {
    try {
      const jobs =
        company.ats === "greenhouse"
          ? await fetchGreenhouse(company.slug)
          : await fetchLever(company.slug);

      for (const job of jobs) {
        if (!seen.has(job.id)) {
          newJobs.push({ company: company.name, job });
          seen.add(job.id);
        }
      }
    } catch (e) {
      console.error(`Failed to fetch ${company.name}:`, e);
    }
  }

  if (newJobs.length === 0) {
    console.log("No new jobs found.");
    saveSeen(seen);
    return;
  }

  // Group by company
  const grouped = new Map<string, Job[]>();
  for (const { company, job } of newJobs) {
    if (!grouped.has(company)) grouped.set(company, []);
    grouped.get(company)!.push(job);
  }

  // Send one message per company (Telegram has 4096 char limit)
  for (const [company, jobs] of grouped) {
    const lines = jobs
      .map((j) => `  • <a href="${j.url}">${j.title}</a> — ${j.location}`)
      .join("\n");
    const msg = `🚨 <b>${company}</b> — ${jobs.length} new job(s)\n\n${lines}`;
    await sendTelegram(msg);
    console.log(`Sent alert for ${company}: ${jobs.length} jobs`);
  }

  saveSeen(seen);
  console.log(`Done. ${newJobs.length} new jobs found total.`);
}

main();
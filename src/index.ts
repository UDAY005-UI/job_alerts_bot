import fs from "fs";
import path from "path";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const SEEN_PATH = path.resolve("seen_jobs.json");

interface Company {
  name: string;
  linkedin: string;
}

interface Job {
  id: string;
  title: string;
  location: string;
  url: string;
}

function loadSeen(): Set<string> {
  if (!fs.existsSync(SEEN_PATH)) return new Set();
  const raw = fs.readFileSync(SEEN_PATH, "utf-8").trim();
  if (!raw) return new Set();
  return new Set(JSON.parse(raw));
}

function saveSeen(seen: Set<string>) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen], null, 2));
}

async function fetchLinkedIn(company: Company): Promise<Job[]> {
  const url = `https://www.linkedin.com/jobs/search/?f_C=${company.linkedin}&keywords=software+engineer&location=India&f_E=1%2C2`;
  const res = await fetch(
    `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=software%20engineer&location=India&f_E=1%2C2&f_C=${company.linkedin}&start=0`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
    }
  );
  if (!res.ok) return [];
  const html = await res.text();
  const jobs: Job[] = [];
  const matches = html.matchAll(/data-entity-urn="urn:li:jobPosting:(\d+)"[\s\S]*?class="base-search-card__title"[^>]*>([^<]+)<[\s\S]*?class="job-search-card__location"[^>]*>([^<]+)</g);
  for (const m of matches) {
    jobs.push({
      id: `li_${m[1]}`,
      title: m[2].trim(),
      location: m[3].trim(),
      url: `https://www.linkedin.com/jobs/view/${m[1]}`,
    });
  }
  return jobs;
}

async function sendTelegram(message: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}

async function main() {
  const companies: Company[] = JSON.parse(fs.readFileSync("companies.json", "utf-8"));
  const seen = loadSeen();
  const newJobs: { company: string; job: Job }[] = [];

  for (const company of companies) {
    try {
      const jobs = await fetchLinkedIn(company);
      for (const job of jobs) {
        if (!seen.has(job.id)) {
          newJobs.push({ company: company.name, job });
          seen.add(job.id);
        }
      }
      console.log(`${company.name}: ${jobs.length} jobs fetched`);
    } catch (e) {
      console.error(`Failed ${company.name}:`, e);
    }
  }

  if (newJobs.length === 0) {
    console.log("No new jobs.");
    saveSeen(seen);
    return;
  }

  const grouped = new Map<string, Job[]>();
  for (const { company, job } of newJobs) {
    if (!grouped.has(company)) grouped.set(company, []);
    grouped.get(company)!.push(job);
  }

  for (const [company, jobs] of grouped) {
    const lines = jobs.map((j) => `  • <a href="${j.url}">${j.title}</a> — ${j.location}`).join("\n");
    await sendTelegram(`🚨 <b>${company}</b> — ${jobs.length} new role(s)\n\n${lines}`);
  }

  saveSeen(seen);
  console.log(`Done. ${newJobs.length} new jobs total.`);
}

main();
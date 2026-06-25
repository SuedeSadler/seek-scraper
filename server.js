import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import http from "http";
import ws from "ws";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = process.env.PORT || 8080;

const CATEGORIES = [
  { name: "information-technology", label: "Technology" },
  { name: "engineering", label: "Engineering" },
  { name: "accounting", label: "Accounting" },
  { name: "marketing-communications", label: "Marketing" },
  { name: "sales", label: "Sales" },
  { name: "healthcare-medical", label: "Healthcare" },
  { name: "education-training", label: "Education" },
  { name: "trades-services", label: "Trades & Services" },
  { name: "administration-office-support", label: "Administration" },
  { name: "construction", label: "Construction" },
];

const MAX_PAGES_PER_CATEGORY = 10;
const DELAY_MS = 1500;

let isRunning = false;
let lastRun = null;
let lastResult = null;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function scrapeCategory(page, category) {
  const listings = [];

  for (let pageNum = 1; pageNum <= MAX_PAGES_PER_CATEGORY; pageNum++) {
    const url = `https://www.seek.co.nz/${category.name}-jobs/in-All-New-Zealand?page=${pageNum}`;
    console.log(`  -> Page ${pageNum}: ${url}`);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(DELAY_MS);

      const noResults = await page.$('[data-automation="NoResultsPanel"]');
      if (noResults) {
        console.log(`  No more results at page ${pageNum}`);
        break;
      }

      const jobs = await page.evaluate((cat) => {
        const cards = document.querySelectorAll('[data-automation="normalJob"]');
        return Array.from(cards).map((card) => {
          const titleEl = card.querySelector('[data-automation="jobTitle"]');
          const companyEl = card.querySelector('[data-automation="jobCompany"]');
          const locationEl = card.querySelector('[data-automation="jobLocation"]');
          const salaryEl = card.querySelector('[data-automation="jobSalary"]');
          const descEl = card.querySelector('[data-automation="jobShortDescription"]');
          const listingDateEl = card.querySelector('[data-automation="jobListingDate"]');
          const linkEl = card.querySelector('a[data-automation="jobTitle"]');

          return {
            title: titleEl?.innerText?.trim() || null,
            company: companyEl?.innerText?.trim() || null,
            location: locationEl?.innerText?.trim() || null,
            salary: salaryEl?.innerText?.trim() || null,
            description_snippet: descEl?.innerText?.trim() || null,
            listing_date: listingDateEl?.innerText?.trim() || null,
            seek_url: linkEl ? "https://www.seek.co.nz" + linkEl.getAttribute("href") : null,
            category: cat.label,
          };
        });
      }, category);

      const valid = jobs.filter((j) => j.title && j.company);
      console.log(`     Found ${valid.length} listings`);
      listings.push(...valid);

      if (valid.length < 20) break;
    } catch (err) {
      console.error(`  Error on page ${pageNum}:`, err.message);
      break;
    }
  }

  return listings;
}

async function embedAndStore(listings) {
  console.log(`\nEmbedding ${listings.length} listings...`);

  const BATCH_SIZE = 20;
  let stored = 0;
  let skipped = 0;

  for (let i = 0; i < listings.length; i += BATCH_SIZE) {
    const batch = listings.slice(i, i + BATCH_SIZE);

    const texts = batch.map((job) => [
      `Job Title: ${job.title}`,
      `Company: ${job.company}`,
      `Location: ${job.location || "Not specified"}`,
      `Category: ${job.category}`,
      `Salary: ${job.salary || "Not specified"}`,
      `Description: ${job.description_snippet || ""}`,
    ].join("\n"));

    try {
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: texts,
      });

      const rows = batch.map((job, idx) => ({
        title: job.title,
        company: job.company,
        location: job.location,
        salary: job.salary,
        category: job.category,
        description_snippet: job.description_snippet,
        listing_date: job.listing_date,
        seek_url: job.seek_url,
        scraped_at: new Date().toISOString(),
        embedding: embeddingResponse.data[idx].embedding,
      }));

      const { error } = await supabase.from("job_listings").upsert(rows, {
        onConflict: "seek_url",
        ignoreDuplicates: true,
      });

      if (error) {
        console.error("  Supabase error:", error.message);
      } else {
        stored += rows.length;
        console.log(`  Stored ${stored}/${listings.length}`);
      }
    } catch (err) {
      console.error(`  Embedding error at batch ${i}:`, err.message);
      skipped += batch.length;
    }

    await sleep(200);
  }

  return { stored, skipped };
}

async function runScrape() {
  if (isRunning) {
    console.log("Scrape already in progress, skipping");
    return;
  }

  isRunning = true;
  lastRun = new Date().toISOString();
  console.log(`\n=== Scrape started: ${lastRun} ===`);

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "en-NZ",
    });

    const page = await context.newPage();
    const allListings = [];

    for (const category of CATEGORIES) {
      console.log(`\nScraping: ${category.label}`);
      const listings = await scrapeCategory(page, category);
      console.log(`  Total for ${category.label}: ${listings.length}`);
      allListings.push(...listings);
    }

    await browser.close();
    console.log(`\nTotal scraped: ${allListings.length}`);

    const result = await embedAndStore(allListings);
    lastResult = { ...result, total: allListings.length, completedAt: new Date().toISOString() };
    console.log(`\n=== Done: ${lastResult.completedAt} ===`);
  } catch (err) {
    console.error("Scrape failed:", err);
    lastResult = { error: err.message };
  } finally {
    isRunning = false;
  }
}

async function debugPage() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-NZ",
  });
  const page = await context.newPage();
  await page.goto("https://www.seek.co.nz/information-technology-jobs/in-All-New-Zealand?page=1", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await sleep(3000);
  const html = await page.content();
  await browser.close();
  return html;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  // Status check
  if (req.method === "GET" && req.url === "/") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", isRunning, lastRun, lastResult }));
    return;
  }

  // Debug: dump rendered HTML to inspect selectors
  if (req.method === "GET" && req.url === "/debug") {
    try {
      const html = await debugPage();
      res.setHeader("Content-Type", "text/html");
      res.writeHead(200);
      res.end(html);
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Trigger scrape
  if (req.method === "POST" && req.url === "/scrape") {
    res.setHeader("Content-Type", "application/json");
    if (isRunning) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: "Scrape already in progress" }));
      return;
    }
    runScrape();
    res.writeHead(202);
    res.end(JSON.stringify({ message: "Scrape started", startedAt: lastRun }));
    return;
  }

  res.setHeader("Content-Type", "application/json");
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`POST /scrape to trigger a run`);
  console.log(`GET  /       to check status`);
  console.log(`GET  /debug  to dump Seek HTML`);
});
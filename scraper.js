import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Categories to scrape — add/remove as needed
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

const MAX_PAGES_PER_CATEGORY = 10; // ~220 listings per category, ~2200 total
const DELAY_MS = 1500; // be polite

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function scrapeCategory(page, category) {
  const listings = [];

  for (let pageNum = 1; pageNum <= MAX_PAGES_PER_CATEGORY; pageNum++) {
    const url = `https://www.seek.co.nz/${category.name}-jobs/in-All-New-Zealand?page=${pageNum}`;
    console.log(`  → Page ${pageNum}: ${url}`);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(DELAY_MS);

      // Check if we've run out of pages
      const noResults = await page.$('[data-automation="NoResultsPanel"]');
      if (noResults) {
        console.log(`  ✓ No more results at page ${pageNum}`);
        break;
      }

      // Extract job cards from the search results
      const jobs = await page.evaluate((cat) => {
        const cards = document.querySelectorAll('[data-automation="normalJob"]');
        return Array.from(cards).map((card) => {
          const titleEl = card.querySelector('[data-automation="jobTitle"]');
          const companyEl = card.querySelector('[data-automation="jobCompany"]');
          const locationEl = card.querySelector(
            '[data-automation="jobLocation"]'
          );
          const salaryEl = card.querySelector('[data-automation="jobSalary"]');
          const descEl = card.querySelector(
            '[data-automation="jobShortDescription"]'
          );
          const listingDateEl = card.querySelector(
            '[data-automation="jobListingDate"]'
          );
          const linkEl = card.querySelector('a[data-automation="jobTitle"]');

          return {
            title: titleEl?.innerText?.trim() || null,
            company: companyEl?.innerText?.trim() || null,
            location: locationEl?.innerText?.trim() || null,
            salary: salaryEl?.innerText?.trim() || null,
            description_snippet: descEl?.innerText?.trim() || null,
            listing_date: listingDateEl?.innerText?.trim() || null,
            seek_url: linkEl
              ? "https://www.seek.co.nz" + linkEl.getAttribute("href")
              : null,
            category: cat.label,
          };
        });
      }, category);

      const valid = jobs.filter((j) => j.title && j.company);
      console.log(`     Found ${valid.length} listings`);
      listings.push(...valid);

      // If fewer than 20 results, probably the last page
      if (valid.length < 20) break;
    } catch (err) {
      console.error(`  ✗ Error on page ${pageNum}:`, err.message);
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

    // Build text to embed for each listing
    const texts = batch.map((job) => {
      return [
        `Job Title: ${job.title}`,
        `Company: ${job.company}`,
        `Location: ${job.location || "Not specified"}`,
        `Category: ${job.category}`,
        `Salary: ${job.salary || "Not specified"}`,
        `Description: ${job.description_snippet || ""}`,
      ].join("\n");
    });

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
        onConflict: "seek_url", // skip duplicates by URL
        ignoreDuplicates: true,
      });

      if (error) {
        console.error("  ✗ Supabase error:", error.message);
      } else {
        stored += rows.length;
        process.stdout.write(`  ✓ ${stored}/${listings.length}\r`);
      }
    } catch (err) {
      console.error(`  ✗ Embedding error at batch ${i}:`, err.message);
      skipped += batch.length;
    }

    await sleep(200); // stay under OpenAI rate limits
  }

  console.log(`\n  Stored: ${stored}, Skipped: ${skipped}`);
}

async function run() {
  console.log("=== Seek NZ Job Scraper ===");
  console.log(`Started: ${new Date().toISOString()}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

  console.log(`\nTotal listings scraped: ${allListings.length}`);

  if (allListings.length > 0) {
    await embedAndStore(allListings);
  }

  console.log(`\nDone: ${new Date().toISOString()}`);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

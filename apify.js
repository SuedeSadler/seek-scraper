import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import ws from "ws";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const APIFY_TOKEN = process.env.APIFY_API_KEY;
const ACTOR_ID = "websift~seek-job-scraper";

const SEEK_CATEGORIES = [
  { url: "https://www.seek.co.nz/information-technology-jobs/in-Auckland", label: "IT" },
  { url: "https://www.seek.co.nz/healthcare-medical-jobs/in-Auckland", label: "Healthcare" },
  { url: "https://www.seek.co.nz/trades-services-jobs/in-Auckland", label: "Trades & Services" },
  { url: "https://www.seek.co.nz/engineering-jobs/in-Auckland", label: "Engineering" },
  { url: "https://www.seek.co.nz/accounting-jobs/in-Auckland", label: "Accounting" },
  { url: "https://www.seek.co.nz/construction-jobs/in-Auckland", label: "Construction" },
  { url: "https://www.seek.co.nz/hospitality-tourism-jobs/in-Auckland", label: "Hospitality" },
  { url: "https://www.seek.co.nz/sales-jobs/in-Auckland", label: "Sales" },
  { url: "https://www.seek.co.nz/education-training-jobs/in-Auckland", label: "Education" },
];

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runActor(category) {
  console.log(`\nScraping: ${category.label}`);

  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchUrl: category.url,
        maxResults: 200,
      }),
    }
  );

  const runData = await runRes.json();
  const runId = runData?.data?.id;
  if (!runId) throw new Error(`Failed to start: ${JSON.stringify(runData)}`);
  console.log(`  Run ID: ${runId}`);

  for (let i = 0; i < 120; i++) {
    await sleep(10000);
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    const statusData = await statusRes.json();
    const status = statusData?.data?.status;
    console.log(`  Status: ${status}`);
    if (status === "SUCCEEDED") break;
    if (status === "FAILED" || status === "ABORTED") throw new Error(`Actor ${status}`);
  }

  const runDetailsRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
  );
  const runDetails = await runDetailsRes.json();
  const datasetId = runDetails?.data?.defaultDatasetId;

  const resultsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json&limit=1000`
  );
  const items = await resultsRes.json();
  const listings = Array.isArray(items) ? items : [];
  console.log(`  Got ${listings.length} listings`);
  return listings.map((item) => ({ ...item, _category: category.label }));
}

async function embedAndStore(listings) {
  console.log(`\nEmbedding ${listings.length} listings...`);
  const BATCH_SIZE = 20;
  let stored = 0;

  for (let i = 0; i < listings.length; i += BATCH_SIZE) {
    const batch = listings.slice(i, i + BATCH_SIZE);

    const texts = batch.map((job) => [
      `Job Title: ${job.title || ""}`,
      `Company: ${job.advertiser?.name || ""}`,
      `Location: ${job.joblocationInfo?.displayLocation || ""}`,
      `Category: ${job._category}`,
      `Sub-category: ${job.classificationInfo?.subClassification || ""}`,
      `Salary: ${job.salary || "Not specified"}`,
      `Work type: ${job.workTypes || ""}`,
      `Work arrangement: ${job.workArrangements || ""}`,
      `Description: ${(job.content?.bulletPoints || []).join(". ")}`,
      `Details: ${(job.content?.sections || []).slice(0, 8).join(". ")}`,
    ].join("\n"));

    try {
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: texts,
      });

      const rows = batch.map((job, idx) => ({
        title: job.title || null,
        company: job.advertiser?.name || null,
        location: job.joblocationInfo?.displayLocation || null,
        salary: job.salary || null,
        category: job._category,
        description_snippet: (job.content?.bulletPoints || []).join(" · ") || job.content?.jobHook || null,
        listing_date: job.listedAt || null,
        seek_url: job.jobLink || null,
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
    }

    await sleep(200);
  }

  return stored;
}

export async function runApifyScrape() {
  console.log("\n=== Apify Seek scrape started ===");
  const allListings = [];

  for (const category of SEEK_CATEGORIES) {
    try {
      const listings = await runActor(category);
      allListings.push(...listings);
    } catch (err) {
      console.error(`Failed for ${category.label}:`, err.message);
    }
    await sleep(2000);
  }

  console.log(`\nTotal Seek listings: ${allListings.length}`);
  const stored = await embedAndStore(allListings);
  console.log(`\n=== Apify done. Stored: ${stored} ===`);
  return stored;
}
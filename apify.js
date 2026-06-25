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
const ACTOR_ID = "5BAoYcBhwvPuMtd0K";

const SEEK_CATEGORIES = [
  { searchUrl: "https://www.seek.co.nz/jobs/in-All-New-Zealand?classification=6281", label: "IT" },
  { searchUrl: "https://www.seek.co.nz/jobs/in-All-New-Zealand?classification=1200", label: "Healthcare" },
  { searchUrl: "https://www.seek.co.nz/jobs/in-All-New-Zealand?classification=6092", label: "Trades & Services" },
  { searchUrl: "https://www.seek.co.nz/jobs/in-All-New-Zealand?classification=1111", label: "Accounting" },
  { searchUrl: "https://www.seek.co.nz/jobs/in-All-New-Zealand?classification=6317", label: "Engineering" },
  { searchUrl: "https://www.seek.co.nz/jobs/in-All-New-Zealand?classification=6251", label: "Construction" },
];

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runActor(searchUrl, label) {
  console.log(`Starting Apify actor for: ${label}`);

  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchUrl,
        maxResults: 100,
      }),
    }
  );

  const runData = await runRes.json();
  const runId = runData?.data?.id;
  if (!runId) throw new Error(`Failed to start actor: ${JSON.stringify(runData)}`);
  console.log(`  Actor run started: ${runId}`);

  // Poll until finished
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    const statusData = await statusRes.json();
    const status = statusData?.data?.status;
    console.log(`  Status: ${status}`);
    if (status === "SUCCEEDED") break;
    if (status === "FAILED" || status === "ABORTED") {
      throw new Error(`Actor run ${status}`);
    }
  }

  // Fetch results
  const resultsRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&format=json`
  );
  const items = await resultsRes.json();
  console.log(`  Got ${items.length} results for ${label}`);
  return items.map((item) => ({ ...item, _category: label }));
}

async function embedAndStore(listings) {
  console.log(`\nEmbedding ${listings.length} Seek listings...`);
  const BATCH_SIZE = 20;
  let stored = 0;

  for (let i = 0; i < listings.length; i += BATCH_SIZE) {
    const batch = listings.slice(i, i + BATCH_SIZE);

    const texts = batch.map((job) => [
      `Job Title: ${job.title || ""}`,
      `Company: ${job.advertiser?.name || ""}`,
      `Location: ${job.joblocationInfo?.displayLocation || ""}`,
      `Category: ${job._category}`,
      `Salary: ${job.salary || "Not specified"}`,
      `Work type: ${job.workTypes || ""}`,
      `Work arrangement: ${job.workArrangements || ""}`,
      `Description: ${job.content?.bulletPoints?.join(". ") || ""}`,
      `Details: ${job.content?.sections?.slice(0, 5).join(". ") || ""}`,
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
        description_snippet: job.content?.bulletPoints?.join(" · ") || job.content?.jobHook || null,
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
        console.error("Supabase error:", error.message);
      } else {
        stored += rows.length;
        console.log(`  Stored ${stored}/${listings.length}`);
      }
    } catch (err) {
      console.error(`Embedding error at batch ${i}:`, err.message);
    }

    await sleep(200);
  }

  return stored;
}

export async function runApifyScrape() {
  console.log("\n=== Apify Seek scrape started ===");
  const allListings = [];

  for (const cat of SEEK_CATEGORIES) {
    try {
      const items = await runActor(cat.searchUrl, cat.label);
      allListings.push(...items);
    } catch (err) {
      console.error(`Failed for ${cat.label}:`, err.message);
    }
  }

  console.log(`\nTotal Seek listings: ${allListings.length}`);
  const stored = await embedAndStore(allListings);
  console.log(`\n=== Apify done. Stored: ${stored} ===`);
  return stored;
}

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

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runActor() {
  console.log("Starting Apify actor — all NZ jobs");

  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchUrl: "https://www.seek.co.nz/jobs/in-All-New-Zealand",
        maxResults: 500,
      }),
    }
  );

  const runData = await runRes.json();
  const runId = runData?.data?.id;
  if (!runId) throw new Error(`Failed to start actor: ${JSON.stringify(runData)}`);
  console.log(`Run ID: ${runId}`);

  // Poll until finished (max 20 mins)
  for (let i = 0; i < 120; i++) {
    await sleep(10000);
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    const statusData = await statusRes.json();
    const status = statusData?.data?.status;
    console.log(`Status: ${status}`);
    if (status === "SUCCEEDED") break;
    if (status === "FAILED" || status === "ABORTED") {
      throw new Error(`Actor run ${status}`);
    }
  }

  const resultsRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&format=json&limit=1000`
  );
  const rawText = await resultsRes.text();
  console.log(`Results response (first 300): ${rawText.slice(0, 300)}`);
  let items = [];
  try {
    const parsed = JSON.parse(rawText);
    items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.data || []);
  } catch(e) {
    console.error("Parse error:", e.message);
  }
  console.log(`Got ${items.length} results`);
  return items;
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
      `Category: ${job.classificationInfo?.classification || ""}`,
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
        category: job.classificationInfo?.classification || null,
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
        console.error("Supabase error:", error.message);
      } else {
        stored += rows.length;
        console.log(`Stored ${stored}/${listings.length}`);
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

  const listings = await runActor();
  console.log(`\nTotal Seek listings: ${listings.length}`);
  const stored = await embedAndStore(listings);
  console.log(`\n=== Apify done. Stored: ${stored} ===`);
  return stored;
}
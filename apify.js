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

// Each entry is one actor run — subclassification slugs mapped to a category label
const SEEK_RUNS = [
  {
    label: "IT",
    subclassifications: {
      "developers-programmers": true,
      "engineering-software": true,
      "networks-systems-administration": true,
      "help-desk-it-support": true,
      "business-systems-analysts": true,
      "information-communication-technology": true,
    },
  },
  {
    label: "Healthcare",
    subclassifications: {
      "nursing-general-medical-surgical": true,
      "nursing-aged-care": true,
      "general-practitioners": true,
      "medical-specialists": true,
      "physiotherapy-ot-rehabilitation": true,
      "healthcare-medical": true,
    },
  },
  {
    label: "Trades & Services",
    subclassifications: {
      "electricians": true,
      "plumbers": true,
      "carpentry-cabinet-making": true,
      "building-trades": true,
      "trades-services": true,
      "maintenance": true,
    },
  },
  {
    label: "Engineering",
    subclassifications: {
      "civil-structural-engineering": true,
      "mechanical-engineering": true,
      "electrical-electronic-engineering": true,
      "engineering-project-management": true,
      "engineering": true,
    },
  },
  {
    label: "Accounting & Finance",
    subclassifications: {
      "accounting": true,
      "financial-accounting-reporting": true,
      "management-accounting-budgeting": true,
      "bookkeeping-small-practice-accounting": true,
      "payroll": true,
    },
  },
  {
    label: "Construction",
    subclassifications: {
      "construction": true,
      "construction-project-management": true,
      "construction-management": true,
      "estimating": true,
      "construction-health-safety-environment": true,
    },
  },
  {
    label: "Hospitality & Tourism",
    subclassifications: {
      "chefs-cooks": true,
      "waiting-staff": true,
      "bar-beverage-staff": true,
      "hospitality-tourism-management": true,
      "front-office-guest-services": true,
    },
  },
  {
    label: "Sales & Marketing",
    subclassifications: {
      "sales-representatives-consultants": true,
      "sales-management": true,
      "new-business-development": true,
      "marketing-communications": true,
      "digital-search-marketing": true,
    },
  },
  {
    label: "Education",
    subclassifications: {
      "teaching-primary": true,
      "teaching-secondary": true,
      "teaching-early-childhood": true,
      "teaching-tertiary": true,
      "education-training": true,
    },
  },
  {
    label: "Transport & Logistics",
    subclassifications: {
      "road-transport": true,
      "warehousing-storage-distribution": true,
      "couriers-drivers-postal-services": true,
      "manufacturing-transport-logistics": true,
      "freight-cargo-forwarding": true,
    },
  },
];

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runActor(run) {
  console.log(`Starting Apify actor for: ${run.label}`);

  const input = {
    maxResults: 50,
    sortBy: "date",
    ...run.subclassifications,
  };

  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );

  const runData = await runRes.json();
  const runId = runData?.data?.id;
  if (!runId) throw new Error(`Failed to start actor: ${JSON.stringify(runData)}`);
  console.log(`  Run ID: ${runId}`);

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

  const resultsRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&format=json`
  );
  const items = await resultsRes.json();
  console.log(`  Got ${items.length} results for ${run.label}`);
  return items.map((item) => ({ ...item, _category: run.label }));
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
      `Description: ${(job.content?.bulletPoints || []).join(". ")}`,
      `Details: ${(job.content?.sections || []).slice(0, 5).join(". ")}`,
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

  for (const run of SEEK_RUNS) {
    try {
      const items = await runActor(run);
      allListings.push(...items);
    } catch (err) {
      console.error(`Failed for ${run.label}:`, err.message);
    }
    await sleep(2000);
  }

  console.log(`\nTotal Seek listings: ${allListings.length}`);
  const stored = await embedAndStore(allListings);
  console.log(`\n=== Apify done. Stored: ${stored} ===`);
  return stored;
}
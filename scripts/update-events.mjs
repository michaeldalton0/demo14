import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUTO_EVENTS_PATH = path.join(ROOT, "src", "_data", "events.auto.json");

const TIME_ZONE = "America/New_York";
const USER_AGENT =
  "Mozilla/5.0 (compatible; WPCNAEventUpdater/1.0; +https://wp-cna.github.io/demo4/)";
const LIBRARY_LOOKAHEAD_DAYS = 120;
const CITY_MONTHS_AHEAD = 6;
const PAST_RETENTION_DAYS = 60;
const LIBRARY_MAX_REPEAT_COUNT = 3;
const LIBRARY_MONTHLY_LIMIT = 40;

const LIBRARY_ALWAYS_EXCLUDE_PATTERN =
  /\b(homework help|video game time|tiny tots|toy time|storytime|vr storytime|vr fun|movie time|movie night|esl|english conversation|english classes|english for beginners|french conversation|low intermediate english|ged|citizenship classes|do gooders|tech tuesday|d&d|puzzle swap|stitching with friends|learn to crochet|crochet|beginner sewing|sewing class|kids yoga|paws to read|salsa for absolute beginners|read and stitch|book discussion|book club|club\b|minecraft|magic: the gathering|edge advisory board|after hours|afterplay|advisory board|scrabble|lego|board of trustees|appointment only|library closed)\b/i;

const LIBRARY_BROAD_INTEREST_PATTERN =
  /\b(workshop|discussion|open mic|concert|history|genealogy|financial aid|college|housing|discrimination|energy|narcan|interview|poetry|artificial intelligence|a\.i\.|3d printing|public service|county legislators|elder law|leadership|heritage|film screening|future is female|mental health|wellness|earth day|white plains|technology|samuel adams|antoni gaudi|janine antoni|craft-making|children's day|book day|brown bag|excel|google sheets|youth leadership|robert the guitar guy|storybook dancing|common ground)\b/i;

const LIBRARY_HIGH_PRIORITY_PATTERN =
  /\b(white plains|county|history|financial aid|college|housing|discrimination|energy|narcan|elder law|genealogy|county legislators|leadership|future is female|artificial intelligence|a\.i\.|3d printing|earth day|heritage|public service|interview|concert|film screening|open mic|poetry)\b/i;

// Recreation Department programming on the city calendar gets its own category
// so it can be surfaced separately (title/venue based — deliberately specific
// to avoid catching civic meetings or the word "Parks" in organizer names).
const PARKS_REC_PATTERN =
  /\b(neighborhood nights?|rock the block|music at the market|concerts? at renaissance plaza|movies? (?:in|at|under) the|movie night|pool|aquatics|swim|splash pad|ice rink|skating|ebersole|day camp|summer camp|rec camp|playground|park cleanup|egg hunt|turkey trot|tree lighting|recreation|rec dept|youth bureau|gardella|delfino|battle hill|turnure|kittrell|druss park|liberty park|chatterton|community center)\b/i;

const COUNTY_PARKS_API = "https://parksevents.westchestergov.com/wp-json/tribe/events/v1/events";
const COUNTY_PARKS_MONTHS_AHEAD = 5;
const COUNTY_PARKS_MONTHLY_LIMIT = 25;
const COUNTY_PARKS_MAX_PAGES = 8;
// County venues that are true parks/preserves -> "Parks & Recreation";
// event venues like the County Center get categorized by content instead.
const COUNTY_PARK_VENUE_PATTERN = /saxon woods|cranberry lake|silver lake|miller house|preserve|\bpark\b|\bpool\b|trailside/i;

const SCHOOL_CALENDAR_ELEMENT_URL = "https://www.whiteplainspublicschools.org/fs/elements/4485";
const SCHOOL_CALENDAR_PAGE_URL = "https://www.whiteplainspublicschools.org/calendar";
const SCHOOL_FINE_ARTS_URL = "https://www.whiteplainspublicschools.org/curriculum/fine-arts/fine-arts-calendar";
const SCHOOL_MONTHS_AHEAD = 5;
const SCHOOL_MONTHLY_LIMIT = 20;
// Only community-facing school events belong on a civic site: performances,
// charity drives, marquee dates, board meetings — not drills or dismissals.
const NOTABLE_SCHOOL_PATTERN =
  /\b(concert|recital|play|musical|drama|theater|theatre|performance|art show|art exhibit|gallery|band|orchestra|chorus|choir|jazz|board of education|first day of school|last day of school|graduation|commencement|moving.up|turkey bowl|homecoming|fundraiser|charity|food drive|coat drive|toy drive|blood drive|college fair|science fair|book fair|multicultural|heritage night|family night|open house)\b/i;

// Marquee high-school games, read back out of the file update-sports.mjs owns.
const SPORTS_DATA_PATH = path.join(ROOT, "src", "_data", "sports.auto.json");
const SPORTS_MONTHLY_LIMIT = 6;
// Section 1 rivalries worth a spot on the main events list whatever the sport.
const SPORTS_RIVAL_PATTERN = /\b(new rochelle|scarsdale|stepinac|mamaroneck|mount vernon)\b/i;
// Postseason games are scheduled late and always lead — no cap, no exceptions.
const SPORTS_PLAYOFF_PATTERN =
  /\b(playoffs?|post[- ]?season|sectionals?|regionals?|championships?|semi[- ]?finals?|quarter[- ]?finals?|finals|state qualifier|turkey bowl)\b/i;
const SPORTS_SPECIAL_PATTERN = /\b(senior night|senior day|homecoming|turkey bowl)\b/i;

const CATEGORY_IMAGES = {
  "Arts": "/assets/img/events/arts.svg",
  "Civic": "/assets/img/events/civic.svg",
  "Community": "/assets/img/events/community.svg",
  "Family": "/assets/img/events/family.svg",
  "Food & Downtown": "/assets/img/events/food.svg",
  "Learning": "/assets/img/events/learning.svg",
  "Music & Family": "/assets/img/events/music.svg",
  "Parks & Recreation": "/assets/img/events/parks.svg",
  "Seasonal": "/assets/img/events/seasonal.svg",
  "Sports": "/assets/img/events/sports.svg",
  "Workshop": "/assets/img/events/workshop.svg"
};

const MONTH_INDEX = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

async function main() {
  const previousAutoEvents = await readJson(AUTO_EVENTS_PATH, []);
  const previousBySource = groupBySource(previousAutoEvents);
  const todayParts = getTodayParts();
  const keepAfter = shiftIsoDate(todayParts.iso, -PAST_RETENTION_DAYS);

  const sourceFetchers = [
    { id: "library", fetcher: () => fetchLibraryEvents(todayParts) },
    { id: "city", fetcher: () => fetchCityEvents(todayParts) },
    { id: "bid", fetcher: () => fetchBidEvents(todayParts) },
    { id: "wppac", fetcher: () => fetchWppacEvents(todayParts) },
    { id: "countyparks", fetcher: () => fetchCountyParksEvents(todayParts) },
    { id: "schools", fetcher: () => fetchSchoolEvents(todayParts) },
    { id: "sports", fetcher: () => fetchSportsEvents(todayParts) }
  ];

  const collected = [];
  let successfulSources = 0;

  for (const source of sourceFetchers) {
    const retainedPrevious = retainRecentEvents(previousBySource[source.id] || [], keepAfter, todayParts.iso);

    try {
      const fresh = await source.fetcher();

      if (!fresh.length) {
        throw new Error("No events parsed.");
      }

      successfulSources += 1;
      collected.push(...mergeWithRetained(fresh, retainedPrevious, keepAfter));
      console.log(`Imported ${fresh.length} ${source.id} events.`);
    } catch (error) {
      console.warn(`Could not refresh ${source.id}: ${error.message}`);
      collected.push(...retainedPrevious);
    }
  }

  if (!successfulSources && !previousAutoEvents.length) {
    throw new Error("All event sources failed and there is no prior auto-generated dataset to keep.");
  }

  const deduped = dedupeImportedEvents(collected)
    .map((event) => normalizeImportedEvent(event, todayParts.iso))
    .sort(compareEventsForOutput);

  await fs.writeFile(AUTO_EVENTS_PATH, JSON.stringify(deduped, null, 2) + "\n", "utf8");
  console.log(`Wrote ${deduped.length} auto-managed events to ${path.relative(ROOT, AUTO_EVENTS_PATH)}.`);
}

function getTodayParts() {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(new Date())
    .replaceAll("/", "-");

  const [year, month, day] = formatted.split("-").map(Number);

  return {
    iso: formatted,
    year,
    month,
    day
  };
}

function shiftIsoDate(isoDate, dayOffset) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

async function fetchLibraryEvents(todayParts) {
  const requestPayload = {
    private: false,
    date: todayParts.iso,
    days: LIBRARY_LOOKAHEAD_DAYS,
    locations: [],
    ages: [],
    types: [],
    search: ""
  };

  const url =
    "https://calendar.whiteplainslibrary.org/eeventcaldata?event_type=0&req=" +
    encodeURIComponent(JSON.stringify(requestPayload));
  const items = await fetchJson(url);

  const candidates = items
    .map((item) => buildLibraryEvent(item, todayParts.iso))
    .filter(Boolean);
  const titleCounts = buildTitleCounts(candidates);

  return limitLibraryEventsByMonth(
    candidates.filter((event) => shouldIncludeLibraryEvent(event, titleCounts)),
    titleCounts
  );
}

function buildLibraryEvent(item, todayIso) {
  const title = collapseWhitespace(item.title);
  const start = parseSqlDateTime(item.raw_start_time);
  const end = parseSqlDateTime(item.raw_end_time);
  const rawTags = dedupeStrings([
    ...(Array.isArray(item.tagsArray) ? item.tagsArray : []),
    ...(Array.isArray(item.agesArray) ? item.agesArray : [])
  ]);

  if (!title || !start.date) {
    return null;
  }

  if (
    rawTags.some((tag) => /reserved|room rental|\(p\)/i.test(tag)) ||
    /\broom rental\b/i.test(title)
  ) {
    return null;
  }

  const description = cleanText(item.long_description || item.description || "");
  const locationParts = [item.location, item.venues].map(cleanText).filter(Boolean);
  const locationName = locationParts.join(", ");
  const tags = dedupeStrings([...rawTags, "library"]).map(toTag);
  const category = categorizeEvent({
    title,
    description,
    organizer: "White Plains Public Library",
    tags
  });

  const detailUrl = absoluteUrl(item.url, "https://calendar.whiteplainslibrary.org/");
  const fullDescription = appendSourceNote(
    description,
    "Check the library page for registration, tickets, and any schedule updates."
  );

  return buildImportedEvent({
    title,
    category,
    shortSummary: buildSummary(description, 160),
    fullDescription,
    startDate: start.date,
    endDate: end.date || start.date,
    startTime: start.time,
    endTime: end.time,
    locationName: locationName || "White Plains Public Library",
    locationAddress: "100 Martine Avenue, White Plains, NY 10601",
    image: imageForCategory(category),
    flyerPdf: null,
    externalUrl: detailUrl,
    ctaLabel: "Open library page",
    featured: false,
    status: deriveStatus(start.date, end.date || start.date, todayIso),
    tags,
    organizer: "White Plains Public Library",
    sourceUrl: detailUrl,
    sourceLabel: "Library calendar",
    importSource: "library"
  });
}

function shouldIncludeLibraryEvent(event, titleCounts) {
  const title = cleanText(event.title).toLowerCase();
  const haystack = `${event.title} ${event.shortSummary} ${event.fullDescription} ${(event.tags || []).join(" ")}`.toLowerCase();
  const titleCount = titleCounts.get(title) || 0;

  if (LIBRARY_ALWAYS_EXCLUDE_PATTERN.test(haystack)) {
    return false;
  }

  if (titleCount > LIBRARY_MAX_REPEAT_COUNT) {
    return false;
  }

  if (event.category === "Civic" || event.category === "Workshop") {
    return true;
  }

  return LIBRARY_BROAD_INTEREST_PATTERN.test(haystack);
}

function limitLibraryEventsByMonth(events, titleCounts) {
  const grouped = new Map();

  for (const event of events) {
    const monthKey = event.startDate.slice(0, 7);
    grouped.set(monthKey, [...(grouped.get(monthKey) || []), event]);
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([, monthEvents]) =>
      monthEvents
        .sort((a, b) => compareLibraryPriority(a, b, titleCounts))
        .slice(0, LIBRARY_MONTHLY_LIMIT)
    );
}

function compareLibraryPriority(a, b, titleCounts) {
  const scoreDiff = scoreLibraryEvent(b, titleCounts) - scoreLibraryEvent(a, titleCounts);

  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  const dateDiff = `${a.startDate}${a.startTime || "00:00"}`.localeCompare(`${b.startDate}${b.startTime || "00:00"}`);
  if (dateDiff !== 0) {
    return dateDiff;
  }

  return a.title.localeCompare(b.title);
}

function scoreLibraryEvent(event, titleCounts) {
  const haystack = `${event.title} ${event.shortSummary} ${event.fullDescription} ${(event.tags || []).join(" ")}`.toLowerCase();
  const titleCount = titleCounts.get(cleanText(event.title).toLowerCase()) || 0;
  let score = 0;

  if (event.category === "Workshop") {
    score += 8;
  } else if (event.category === "Civic") {
    score += 7;
  } else if (event.category === "Learning") {
    score += 4;
  } else {
    score += 3;
  }

  if (LIBRARY_HIGH_PRIORITY_PATTERN.test(haystack)) {
    score += 7;
  }

  if (/\b(white plains|county|local|neighborhood)\b/i.test(haystack)) {
    score += 3;
  }

  if (/\b(workshop|discussion|lecture|series|screening|concert|open mic)\b/i.test(haystack)) {
    score += 2;
  }

  score -= Math.max(0, titleCount - 1) * 2;

  return score;
}

async function fetchCityEvents(todayParts) {
  const months = buildMonthSequence(todayParts, CITY_MONTHS_AHEAD);
  const collected = [];

  for (const monthEntry of months) {
    const url = `https://www.cityofwhiteplains.com/Calendar.aspx?month=${monthEntry.month}&year=${monthEntry.year}`;
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    $(".detailsTooltip").each((_, tooltip) => {
      const container = $(tooltip);
      const title = cleanText(container.find("h3").first().text());
      const detailsLink = container.find("a[href*='Calendar.aspx?EID=']").first().attr("href");
      const detailUrl = absoluteUrl(detailsLink, "https://www.cityofwhiteplains.com/");

      if (!title || !detailUrl || /\bcancelled\b|\bno meeting scheduled\b/i.test(title)) {
        return;
      }

      const params = new URL(detailUrl).searchParams;
      const year = params.get("year");
      const month = params.get("month");
      const day = params.get("day");

      if (!year || !month || !day) {
        return;
      }

      const startDate = `${year}-${padNumber(month)}-${padNumber(day)}`;
      const timeText = cleanText(container.find("dt").filter((_, dt) => cleanText($(dt).text()) === "When:").next("dd").text());
      const locationHtml = container.find("dt").filter((_, dt) => cleanText($(dt).text()) === "Location:").next("dd").html() || "";
      const locationLines = extractHtmlLines(locationHtml);
      const locationName = locationLines[0] || "White Plains";
      const locationAddress = locationLines.slice(1).join(", ") || "White Plains, NY";
      const parsedTimes = parseTimeRange(timeText);

      const description = buildCityDescription(title, locationName, locationAddress);
      const isRecEvent = PARKS_REC_PATTERN.test(`${title} ${locationLines.join(" ")}`);
      const category = isRecEvent
        ? "Parks & Recreation"
        : categorizeEvent({
            title,
            description,
            organizer: "City of White Plains",
            tags: locationLines
          });

      collected.push(
        buildImportedEvent({
          title,
          category,
          shortSummary: buildSummary(description, 155),
          fullDescription: appendSourceNote(
            description,
            "Use the official city page for agendas, updates, and any location changes."
          ),
          startDate,
          endDate: startDate,
          startTime: parsedTimes.startTime,
          endTime: parsedTimes.endTime,
          locationName,
          locationAddress,
          image: imageForCategory(category),
          flyerPdf: null,
          externalUrl: detailUrl,
          ctaLabel: "Open city page",
          featured: false,
          status: deriveStatus(startDate, startDate, todayParts.iso),
          tags: dedupeStrings(buildCityTags(title, locationLines, category)),
          organizer: "City of White Plains",
          sourceUrl: detailUrl,
          sourceLabel: "City calendar",
          importSource: "city"
        })
      );
    });
  }

  return collected;
}

function buildCityDescription(title, locationName, locationAddress) {
  const pieces = [`${title} is listed on the official White Plains city calendar.`];

  if (locationName && locationName !== "White Plains") {
    pieces.push(`It is set for ${locationName}${locationAddress ? `, ${locationAddress}` : ""}.`);
  } else if (locationAddress) {
    pieces.push(`It is set for ${locationAddress}.`);
  }

  return pieces.join(" ");
}

function buildCityTags(title, locationLines, category) {
  const haystack = `${title} ${locationLines.join(" ")} ${category}`.toLowerCase();
  const tags = ["city calendar"];

  if (haystack.includes("meeting")) {
    tags.push("public meeting");
  }

  if (haystack.includes("council")) {
    tags.push("city hall");
  }

  if (haystack.includes("community center")) {
    tags.push("community center");
  }

  if (haystack.includes("mamaroneck")) {
    tags.push("downtown");
  }

  return tags.map(toTag);
}

async function fetchBidEvents(todayParts) {
  const html = await fetchText("https://wpbid.com/events/");
  const $ = cheerio.load(html);
  const collected = [];

  $("article.post-item.event").each((_, article) => {
    const card = $(article);
    const title = cleanText(card.find("h2").first().text());
    const link = absoluteUrl(card.find("h2 a").first().attr("href"), "https://wpbid.com/events/");
    const excerpt = cleanText(card.find(".excerpt").first().text());
    const datetime = card.find("time.entry-time").attr("datetime") || "";
    const timeText = cleanText(card.find(".inner-time").text());
    const parsedTimes = parseTimeRange(timeText);
    const startDate = datetime.slice(0, 10);

    if (!title || !link || !startDate) {
      return;
    }

    const category = categorizeEvent({
      title,
      description: excerpt,
      organizer: "White Plains Business Improvement District",
      tags: ["downtown"]
    });
    const detail = buildBidDescription(title, excerpt);
    const location = guessBidLocation(title, excerpt);

    collected.push(
      buildImportedEvent({
        title,
        category,
        shortSummary: buildSummary(excerpt || detail, 165),
        fullDescription: appendSourceNote(detail, "Use the BID page for tickets, participating businesses, and weather updates."),
        startDate,
        endDate: startDate,
        startTime: parsedTimes.startTime || datetime.slice(11, 16) || null,
        endTime: parsedTimes.endTime,
        locationName: location.name,
        locationAddress: location.address,
        image: imageForCategory(category),
        flyerPdf: null,
        externalUrl: link,
        ctaLabel: buildBidCta(title, excerpt),
        featured: false,
        status: deriveStatus(startDate, startDate, todayParts.iso),
        tags: dedupeStrings(["downtown", "bid", ...extractKeywordTags(`${title} ${excerpt}`)]).map(toTag),
        organizer: "White Plains Business Improvement District",
        sourceUrl: link,
        sourceLabel: "White Plains BID",
        importSource: "bid"
      })
    );
  });

  return collected;
}

function buildBidDescription(title, excerpt) {
  if (excerpt) {
    return excerpt.endsWith("…") || excerpt.endsWith("[…]") ? excerpt.replace(/\[…\]$|…$/u, "").trim() + "." : excerpt;
  }

  return `${title} is listed on the White Plains BID events calendar.`;
}

function buildBidCta(title, excerpt) {
  const haystack = `${title} ${excerpt}`.toLowerCase();
  if (/\b(ticket|tickets|buy)\b/.test(haystack)) {
    return "Get tickets";
  }

  return "Open event page";
}

function guessBidLocation(title, excerpt) {
  const haystack = `${title} ${excerpt}`.toLowerCase();

  if (haystack.includes("mamaroneck avenue")) {
    return {
      name: "Mamaroneck Avenue Streetscape",
      address: "Mamaroneck Avenue between Maple Avenue and East Post Road, White Plains, NY 10601"
    };
  }

  if (haystack.includes("downtown")) {
    return {
      name: "Downtown White Plains",
      address: "Downtown White Plains, NY 10601"
    };
  }

  return {
    name: "White Plains BID District",
    address: "Downtown White Plains, NY 10601"
  };
}

async function fetchWppacEvents(todayParts) {
  const html = await fetchText("https://wppac.com/");
  const $ = cheerio.load(html);
  const links = dedupeStrings(
    $("a[href*='https://wppac.com/shows/'], a[href^='/shows/']")
      .map((_, anchor) => absoluteUrl($(anchor).attr("href"), "https://wppac.com/"))
      .get()
      .filter(Boolean)
  );

  const collected = [];

  for (const link of links) {
    let showHtml;

    try {
      showHtml = await fetchText(link);
    } catch (error) {
      console.warn(`Skipping WPPAC show page ${link}: ${error.message}`);
      continue;
    }

    const show = buildWppacEvent(showHtml, link, todayParts);

    if (show) {
      collected.push(show);
    }
  }

  return collected;
}

function buildWppacEvent(html, link, todayParts) {
  const $ = cheerio.load(html);
  const title = cleanText($("h1").first().text());

  if (!title) {
    return null;
  }

  const paragraphs = $("p")
    .map((_, paragraph) => cleanText($(paragraph).text()))
    .get()
    .filter(Boolean);

  const aboutText = paragraphs.find((text) => text.length > 120 && !/licensed by|performance schedule|all sales are final/i.test(text));
  const dateRangeText = paragraphs.find((text) => parseMonthRange(text, todayParts));
  const dateRange = parseMonthRange(dateRangeText, todayParts);

  if (!dateRange) {
    return null;
  }

  const extraNotes = [];
  const ageNote = paragraphs.find((text) => /recommend/i.test(text));
  const priceNote = paragraphs.find((text) => /\$\d/.test(text));

  if (ageNote) {
    extraNotes.push(ageNote);
  }

  if (priceNote) {
    extraNotes.push(priceNote);
  }

  const fullDescription = appendSourceNote(
    [aboutText, ...extraNotes].filter(Boolean).join(" "),
    "Use the show page for tickets and the full performance schedule."
  );

  return buildImportedEvent({
    title: toTitleCase(title),
    category: "Arts",
    shortSummary: buildSummary(aboutText || `${title} is on the schedule at the White Plains Performing Arts Center.`, 165),
    fullDescription,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    startTime: null,
    endTime: null,
    locationName: "White Plains Performing Arts Center",
    locationAddress: "11 City Place, 3rd Floor, White Plains, NY 10601",
    image: imageForCategory("Arts"),
    flyerPdf: null,
    externalUrl: link,
    ctaLabel: "Open show page",
    featured: false,
    status: deriveStatus(dateRange.startDate, dateRange.endDate, todayParts.iso),
    tags: dedupeStrings(["performing arts", "theater", ...extractKeywordTags(`${title} ${aboutText || ""}`)]).map(toTag),
    organizer: "White Plains Performing Arts Center",
    sourceUrl: link,
    sourceLabel: "WPPAC",
    importSource: "wppac"
  });
}

function parseMonthRange(text, todayParts) {
  if (!text) {
    return null;
  }

  const normalized = cleanText(text).replace(/[–—]/g, "-");
  const match = normalized.match(/^([A-Za-z]+)\s+(\d{1,2})\s*-\s*([A-Za-z]+)?\s*(\d{1,2})$/);

  if (!match) {
    return null;
  }

  const startMonthName = match[1].toLowerCase();
  const endMonthName = (match[3] || match[1]).toLowerCase();
  const startMonth = MONTH_INDEX[startMonthName];
  const endMonth = MONTH_INDEX[endMonthName];

  if (!startMonth || !endMonth) {
    return null;
  }

  let year = todayParts.year;
  if (startMonth < todayParts.month - 1) {
    year += 1;
  }

  let endYear = year;
  if (endMonth < startMonth) {
    endYear += 1;
  }

  return {
    startDate: `${year}-${padNumber(startMonth)}-${padNumber(match[2])}`,
    endDate: `${endYear}-${padNumber(endMonth)}-${padNumber(match[4])}`
  };
}

async function fetchCountyParksEvents(todayParts) {
  const endDate = shiftIsoDate(todayParts.iso, COUNTY_PARKS_MONTHS_AHEAD * 31);
  const collected = [];

  for (let page = 1; page <= COUNTY_PARKS_MAX_PAGES; page += 1) {
    const url = `${COUNTY_PARKS_API}?per_page=50&page=${page}&start_date=${todayParts.iso}&end_date=${endDate}`;
    let payload;

    try {
      payload = await fetchJson(url);
    } catch (error) {
      if (page === 1) {
        throw error;
      }

      break;
    }

    const items = Array.isArray(payload.events) ? payload.events : [];

    for (const item of items) {
      const event = buildCountyParksEvent(item, todayParts.iso);

      if (event) {
        collected.push(event);
      }
    }

    if (!items.length || !payload.next_rest_url) {
      break;
    }
  }

  return limitEventsByMonth(dedupeImportedEvents(collected), COUNTY_PARKS_MONTHLY_LIMIT);
}

function buildCountyParksEvent(item, todayIso) {
  const venue = item.venue || {};
  const venueCity = cleanText(venue.city || "");

  if (!/white plains/i.test(venueCity)) {
    return null;
  }

  const title = cleanText(item.title);
  const startDate = String(item.start_date || "").slice(0, 10);

  if (!title || !startDate || /^cancell?ed/i.test(title)) {
    return null;
  }

  const allDay = Boolean(item.all_day);
  const endDate = String(item.end_date || "").slice(0, 10) || startDate;
  const startTime = allDay ? null : String(item.start_date || "").slice(11, 16) || null;
  const endTime = allDay ? null : String(item.end_date || "").slice(11, 16) || null;
  const description = buildSummary(cleanText(item.description || ""), 600);
  const venueName = cleanText(venue.venue || "Westchester County Parks");
  const locationAddress = [cleanText(venue.address), [venueCity, "NY"].filter(Boolean).join(", "), cleanText(venue.zip)]
    .filter(Boolean)
    .join(", ");
  const isParkVenue = COUNTY_PARK_VENUE_PATTERN.test(venueName);
  const category = isParkVenue
    ? "Parks & Recreation"
    : categorizeEvent({
        title,
        description,
        organizer: "Westchester County",
        tags: [venueName]
      });
  const cost = cleanText(item.cost || "");
  const costNote = cost && !/^free$/i.test(cost) ? `Cost: ${cost}.` : cost ? "Free to attend." : "";
  const detailUrl = normalizeUrl(item.url);
  const fullDescription = appendSourceNote(
    [description, costNote].filter(Boolean).join(" "),
    "Check the county parks page for registration, tickets, and any schedule updates."
  );

  return buildImportedEvent({
    title,
    category,
    shortSummary: buildSummary(description || `${title} is on the Westchester County Parks calendar.`, 165),
    fullDescription,
    startDate,
    endDate,
    startTime,
    endTime,
    locationName: venueName,
    locationAddress: locationAddress || "White Plains, NY",
    image: imageForCategory(category),
    flyerPdf: null,
    externalUrl: detailUrl,
    ctaLabel: "Open county parks page",
    featured: false,
    status: deriveStatus(startDate, endDate, todayIso),
    tags: dedupeStrings(["county parks", isParkVenue ? "parks & recreation" : "", ...extractKeywordTags(`${title} ${description}`)]).map(toTag),
    organizer: "Westchester County Parks",
    sourceUrl: detailUrl,
    sourceLabel: "County Parks calendar",
    importSource: "countyparks"
  });
}

async function fetchSchoolEvents(todayParts) {
  const [districtEvents, fineArtsEvents] = await Promise.all([
    fetchSchoolDistrictCalendar(todayParts).catch((error) => {
      console.warn(`Schools district calendar failed: ${error.message}`);
      return [];
    }),
    fetchSchoolFineArtsCalendar(todayParts).catch((error) => {
      console.warn(`Schools fine arts calendar failed: ${error.message}`);
      return [];
    })
  ]);

  return limitEventsByMonth(dedupeImportedEvents([...districtEvents, ...fineArtsEvents]), SCHOOL_MONTHLY_LIMIT);
}

async function fetchSchoolDistrictCalendar(todayParts) {
  const months = buildMonthSequence(todayParts, SCHOOL_MONTHS_AHEAD);
  const collected = [];

  for (const monthEntry of months) {
    const url = `${SCHOOL_CALENDAR_ELEMENT_URL}?cal_date=${monthEntry.year}-${padNumber(monthEntry.month)}-01`;
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    $(".fsCalendarDaybox").each((_, box) => {
      const container = $(box);
      const dateEl = container.find(".fsCalendarDate").first();
      const year = Number(dateEl.attr("data-year"));
      const monthIndex = Number(dateEl.attr("data-month"));
      const day = Number(dateEl.attr("data-day"));

      if (!year || Number.isNaN(monthIndex) || !day) {
        return;
      }

      const startDate = `${year}-${padNumber(monthIndex + 1)}-${padNumber(day)}`;

      if (startDate < todayParts.iso) {
        return;
      }

      container.find(".fsCalendarInfo").each((__, info) => {
        const entry = $(info);
        const title = cleanText(entry.find(".fsCalendarEventTitle").first().attr("title") || entry.find(".fsCalendarEventTitle").first().text());

        if (!title || !NOTABLE_SCHOOL_PATTERN.test(title)) {
          return;
        }

        const timeText = cleanText(entry.find(".fsTimeRange").first().text());
        const parsedTimes = /all day/i.test(timeText) ? { startTime: null, endTime: null } : parseTimeRange(timeText);
        const locationName = cleanText(entry.find(".fsLocation").first().text()) || "White Plains Public Schools";
        const detectedCategory = categorizeEvent({
          title,
          description: "",
          organizer: "White Plains Public Schools",
          tags: ["school district"]
        });
        const category = detectedCategory === "Community" ? "Learning" : detectedCategory;
        const description = `${title} is listed on the White Plains City School District calendar.`;

        collected.push(
          buildImportedEvent({
            title,
            category,
            shortSummary: buildSummary(description, 155),
            fullDescription: appendSourceNote(description, "Check the district calendar for updates and details."),
            startDate,
            endDate: startDate,
            startTime: parsedTimes.startTime,
            endTime: parsedTimes.endTime,
            locationName,
            locationAddress: "White Plains, NY",
            image: imageForCategory(category),
            flyerPdf: null,
            externalUrl: SCHOOL_CALENDAR_PAGE_URL,
            ctaLabel: "Open district calendar",
            featured: false,
            status: deriveStatus(startDate, startDate, todayParts.iso),
            tags: dedupeStrings(["schools", "school district", ...extractKeywordTags(title)]).map(toTag),
            organizer: "White Plains Public Schools",
            sourceUrl: SCHOOL_CALENDAR_PAGE_URL,
            sourceLabel: "School district calendar",
            importSource: "schools"
          })
        );
      });
    });
  }

  return collected;
}

async function fetchSchoolFineArtsCalendar(todayParts) {
  const html = await fetchText(SCHOOL_FINE_ARTS_URL);
  const $ = cheerio.load(html);
  const collected = [];
  const lines = $("body")
    .text()
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s*[-–—]\s*(.+)$/);

    if (!match) {
      continue;
    }

    const month = MONTH_INDEX[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);

    if (!month || !day || !year) {
      continue;
    }

    const startDate = `${year}-${padNumber(month)}-${padNumber(day)}`;

    if (startDate < todayParts.iso) {
      continue;
    }

    const remainder = match[4];
    const segments = remainder.split(/\s+[-–—]\s+/);
    const venue = segments.length > 1 ? cleanText(segments[segments.length - 1]) : "";
    let titlePart = cleanText(segments.slice(0, Math.max(1, segments.length - 1)).join(" - "));
    let startTime = null;
    const timeMatch = titlePart.match(/,\s*((?:\d{1,2})(?::\d{2})?\s*[ap]\.?m\.?)\s*$/i);

    if (timeMatch) {
      startTime = parseTime(timeMatch[1]);
      titlePart = cleanText(titlePart.slice(0, timeMatch.index));
    }

    if (!titlePart) {
      continue;
    }

    const description = `${titlePart} is on the White Plains Public Schools fine arts calendar${venue ? ` at ${venue}` : ""}.`;

    collected.push(
      buildImportedEvent({
        title: titlePart,
        category: "Arts",
        shortSummary: buildSummary(description, 155),
        fullDescription: appendSourceNote(description, "Check the fine arts calendar for updates and details."),
        startDate,
        endDate: startDate,
        startTime,
        endTime: null,
        locationName: venue || "White Plains Public Schools",
        locationAddress: "White Plains, NY",
        image: imageForCategory("Arts"),
        flyerPdf: null,
        externalUrl: SCHOOL_FINE_ARTS_URL,
        ctaLabel: "Open fine arts calendar",
        featured: false,
        status: deriveStatus(startDate, startDate, todayParts.iso),
        tags: dedupeStrings(["schools", "fine arts", ...extractKeywordTags(titlePart)]).map(toTag),
        organizer: "White Plains Public Schools",
        sourceUrl: SCHOOL_FINE_ARTS_URL,
        sourceLabel: "WPCSD Fine Arts calendar",
        importSource: "schools"
      })
    );
  }

  return collected;
}

/**
 * Promotes a trickle of marquee games from the sports hub onto the main events
 * list. scripts/update-sports.mjs owns sports.auto.json; this only reads it.
 */
async function fetchSportsEvents(todayParts) {
  const data = await readJson(SPORTS_DATA_PATH, null);

  if (!data || !Array.isArray(data.games) || !data.games.length) {
    throw new Error("No sports dataset available yet.");
  }

  const marquee = data.games
    .filter((game) => game.startDate && game.startDate >= todayParts.iso)
    .map((game) => buildSportsEvent(game, todayParts.iso))
    .filter(Boolean);

  // Postseason games bypass the monthly cap entirely — if the team is playing
  // for a section title, that belongs on the events page no matter how busy
  // the month already is.
  const postseason = marquee.filter((event) => event.featured);
  const regular = marquee.filter((event) => !event.featured);

  return dedupeImportedEvents([...postseason, ...limitEventsByMonth(regular, SPORTS_MONTHLY_LIMIT)]);
}

function buildSportsEvent(game, todayIso) {
  const haystack = `${game.title || ""} ${game.gameType || ""} ${game.notes || ""}`;
  const isScrimmage = /scrimmage/i.test(game.gameType || "");
  const isPostseason = SPORTS_PLAYOFF_PATTERN.test(haystack);
  const isRivalry = SPORTS_RIVAL_PATTERN.test(game.opponent || "");
  const isSpecial = SPORTS_SPECIAL_PATTERN.test(haystack);
  const isHome = game.isHome !== false;
  const isHomeFootball = isHome && /football/i.test(game.sport || "");

  if (!isPostseason && !isRivalry && !isSpecial && !isHomeFootball) {
    return null;
  }

  // Preseason scrimmages are not the big game.
  if (isScrimmage && !isPostseason) {
    return null;
  }

  const opponent = cleanText(game.opponent) || "an opponent to be announced";
  const teamName = cleanText(game.teamName) || `White Plains ${cleanText(game.sport)}`;
  const venue = cleanText(game.locationName) || (isHome ? "White Plains High School" : "");
  const title = isHome ? `${teamName} vs. ${opponent}` : `${teamName} at ${opponent}`;
  const occasion = isPostseason
    ? "Postseason play."
    : isSpecial
      ? "A marquee date on the schedule."
      : isRivalry
        ? "A Section 1 rivalry game."
        : "";
  const shortSummary = [
    isHome ? `${teamName} hosts ${opponent}` : `${teamName} travels to face ${opponent}`,
    venue ? `at ${venue}.` : ".",
    occasion
  ]
    .join(" ")
    .replace(/\s+\./g, ".")
    .trim();
  // Everything a reader needs stays on wp-cna.org — no trip to a third-party site.
  const details = [
    `${isHome ? "Home" : "Away"} ${/football|soccer|basketball|volleyball|baseball|softball|hockey|lacrosse/i.test(game.sport || "") ? "game" : "event"}.`,
    game.startTime ? `Scheduled start ${formatClockLabel(game.startTime)}.` : "Start time to be announced.",
    venue ? `Venue: ${venue}.` : "",
    cleanText(game.gameType) && !/regular season/i.test(game.gameType) ? `${cleanText(game.gameType)}.` : "",
    cleanText(game.notes) ? `Note: ${cleanText(game.notes)}.` : ""
  ]
    .filter(Boolean)
    .join(" ");

  return buildImportedEvent({
    title,
    category: "Sports",
    shortSummary: buildSummary(shortSummary, 165),
    fullDescription: appendSourceNote(
      [shortSummary, details].filter(Boolean).join(" "),
      "Schedules come from the school's athletic department and can change late in the week."
    ),
    startDate: game.startDate,
    endDate: game.startDate,
    startTime: game.startTime || null,
    endTime: game.endTime || null,
    locationName: venue,
    locationAddress: isHome ? "White Plains, NY" : "",
    image: imageForCategory("Sports"),
    flyerPdf: null,
    // Deliberately internal: the hub is the destination, not a third-party site.
    // A relative URL yields no dedupe key, so identity falls back to the slug —
    // still unique per game, so a season cannot collapse into one listing.
    externalUrl: `/sports/${game.sportSlug || slugify(game.sport || "")}/`,
    ctaLabel: "See the full schedule",
    featured: isPostseason,
    status: deriveStatus(game.startDate, game.startDate, todayIso),
    tags: dedupeStrings([
      "sports",
      cleanText(game.sport).toLowerCase(),
      cleanText(game.gender).toLowerCase(),
      "white plains high school",
      isPostseason ? "playoffs" : "",
      isRivalry ? "rivalry" : ""
    ]).map(toTag),
    organizer: "White Plains High School Athletics",
    sourceUrl: null,
    sourceLabel: "White Plains High School Athletics",
    importSource: "sports"
  });
}

function limitEventsByMonth(events, monthlyLimit) {
  const grouped = new Map();

  for (const event of events) {
    const monthKey = event.startDate.slice(0, 7);
    grouped.set(monthKey, [...(grouped.get(monthKey) || []), event]);
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([, monthEvents]) => monthEvents.sort(compareEventsForOutput).slice(0, monthlyLimit));
}

function normalizeImportedEvent(event, todayIso) {
  return {
    ...event,
    shortSummary: buildSummary(event.shortSummary || event.fullDescription || event.title, 170),
    fullDescription: cleanText(event.fullDescription),
    status: deriveStatus(event.startDate, event.endDate || event.startDate, todayIso),
    tags: dedupeStrings(event.tags || []).map(toTag)
  };
}

function buildImportedEvent(event) {
  const slugBase = event.slug || `${event.importSource}-${event.title}-${event.startDate}`;
  return {
    id: slugify(slugBase),
    slug: slugify(slugBase),
    title: cleanText(event.title),
    category: event.category,
    shortSummary: cleanText(event.shortSummary),
    fullDescription: cleanText(event.fullDescription),
    startDate: event.startDate,
    endDate: event.endDate || event.startDate,
    startTime: event.startTime || null,
    endTime: event.endTime || null,
    locationName: cleanText(event.locationName),
    locationAddress: cleanText(event.locationAddress),
    image: event.image,
    flyerPdf: event.flyerPdf || null,
    externalUrl: event.externalUrl || null,
    ctaLabel: event.ctaLabel || "Get info",
    featured: Boolean(event.featured),
    status: event.status,
    tags: dedupeStrings(event.tags || []).map(toTag),
    organizer: cleanText(event.organizer),
    sourceUrl: event.sourceUrl || event.externalUrl || null,
    sourceLabel: event.sourceLabel || "Original source",
    importSource: event.importSource
  };
}

function deriveStatus(startDate, endDate, todayIso) {
  return (endDate || startDate) < todayIso ? "past" : "upcoming";
}

function compareEventsForOutput(a, b) {
  const left = `${a.startDate}${a.startTime || "00:00"}${a.title}`;
  const right = `${b.startDate}${b.startTime || "00:00"}${b.title}`;
  return left.localeCompare(right);
}

function retainRecentEvents(events, keepAfter, todayIso) {
  return events.filter((event) => {
    const endDate = event.endDate || event.startDate;
    return endDate >= keepAfter && endDate < todayIso;
  });
}

function mergeWithRetained(freshEvents, previousEvents, keepAfter) {
  const merged = dedupeImportedEvents([...previousEvents, ...freshEvents]);
  return merged.filter((event) => (event.endDate || event.startDate) >= keepAfter);
}

function dedupeImportedEvents(events) {
  const deduped = [];
  const keyToIndex = new Map();

  for (const event of events) {
    const keys = importedEventKeys(event);
    const existingIndex = keys.find((key) => keyToIndex.has(key));

    if (existingIndex) {
      const dedupedIndex = keyToIndex.get(existingIndex);
      deduped[dedupedIndex] = event;

      for (const key of keys) {
        keyToIndex.set(key, dedupedIndex);
      }

      continue;
    }

    const nextIndex = deduped.push(event) - 1;

    for (const key of keys) {
      keyToIndex.set(key, nextIndex);
    }
  }

  return deduped;
}

function buildTitleCounts(events) {
  return events.reduce((counts, event) => {
    const title = cleanText(event.title).toLowerCase();
    counts.set(title, (counts.get(title) || 0) + 1);
    return counts;
  }, new Map());
}

function importedEventKeys(event) {
  const keys = [];
  const baseTitle = cleanText(event.title).toLowerCase();
  const startDate = event.startDate || "";
  const locationName = cleanText(event.locationName || "").toLowerCase();

  if (event.id) {
    keys.push(`id:${event.id}`);
  }

  if (event.slug) {
    keys.push(`slug:${event.slug}`);
  }

  for (const url of [event.externalUrl, event.sourceUrl]) {
    const normalizedUrl = normalizeUrl(url);
    if (normalizedUrl) {
      keys.push(`url:${normalizedUrl}`);
    }
  }

  if (baseTitle && startDate) {
    keys.push(`title:${baseTitle}|${startDate}|${locationName}`);
  }

  return dedupeStrings(keys);
}

function groupBySource(events) {
  return events.reduce((accumulator, event) => {
    const source = event.importSource || "manual";
    accumulator[source] = accumulator[source] || [];
    accumulator[source].push(event);
    return accumulator;
  }, {});
}

function imageForCategory(category) {
  return CATEGORY_IMAGES[category] || CATEGORY_IMAGES.Community;
}

function categorizeEvent({ title = "", description = "", organizer = "", tags = [] }) {
  const haystack = `${title} ${description} ${organizer} ${tags.join(" ")}`.toLowerCase();

  if (/\b(council|board|commission|agency|committee|work session|meeting|public hearing|vision zero|zoning|planning)\b/.test(haystack)) {
    return "Civic";
  }

  if (/\b(workshop|speaker|training|seminar|clinic)\b/.test(haystack)) {
    return "Workshop";
  }

  if (/\b(steam|library|book|author|conversation|learn|education|class|school budget|lecture)\b/.test(haystack)) {
    return "Learning";
  }

  if (/\b(theater|theatre|musical|show|broadway|performing arts|actors)\b/.test(haystack)) {
    return "Arts";
  }

  if (/\b(concert|music|band|rock the block)\b/.test(haystack)) {
    return "Music & Family";
  }

  if (/\b(wing walk|market|food|restaurant|downtown|oktoberfest|block-toberfest)\b/.test(haystack)) {
    return "Food & Downtown";
  }

  if (/\b(parade|egg hunt|kids|children|families|family)\b/.test(haystack)) {
    return "Family";
  }

  return "Community";
}

function extractKeywordTags(text) {
  const haystack = (text || "").toLowerCase();
  const tags = [];
  const patterns = [
    "tickets",
    "free",
    "family",
    "kids",
    "downtown",
    "music",
    "theater",
    "library",
    "public meeting",
    "registration required"
  ];

  for (const pattern of patterns) {
    if (haystack.includes(pattern)) {
      tags.push(pattern);
    }
  }

  return tags;
}

function buildSummary(text, maxLength) {
  const cleaned = cleanText(text);

  if (!cleaned) {
    return "";
  }

  const sentenceMatch = cleaned.match(/^.{1,170}?[.!?](?=\s|$)/);

  if (sentenceMatch && sentenceMatch[0].length <= maxLength && sentenceMatch[0].trim().length > 20) {
    return sentenceMatch[0].trim();
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const clipped = cleaned.slice(0, maxLength - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
}

function appendSourceNote(text, note) {
  const cleaned = cleanText(text);
  if (!cleaned) {
    return note;
  }

  if (cleaned.includes(note)) {
    return cleaned;
  }

  return `${cleaned} ${note}`;
}

function extractHtmlLines(html) {
  if (!html) {
    return [];
  }

  const $ = cheerio.load(`<div>${html}</div>`);
  const lines = $("p")
    .map((_, paragraph) => cleanText($(paragraph).text()))
    .get()
    .filter(Boolean);

  if (lines.length) {
    return lines;
  }

  return cleanText($.text())
    .split(",")
    .map((part) => cleanText(part))
    .filter(Boolean);
}

function parseSqlDateTime(value) {
  if (!value) {
    return { date: null, time: null };
  }

  const match = value.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);

  if (!match) {
    return { date: null, time: null };
  }

  return {
    date: match[1],
    time: match[2]
  };
}

function parseTimeRange(value) {
  const normalized = cleanText(value).replace(/[–—]/g, "-");

  if (!normalized) {
    return { startTime: null, endTime: null };
  }

  const segments = normalized.split(/\s*-\s*/);

  if (segments.length >= 2) {
    return {
      startTime: parseTime(segments[0]),
      endTime: parseTime(segments[1])
    };
  }

  return {
    startTime: parseTime(normalized),
    endTime: null
  };
}

function parseTime(value) {
  const normalized = cleanText(value).toLowerCase().replaceAll(".", "");

  if (!normalized) {
    return null;
  }

  if (normalized === "noon") {
    return "12:00";
  }

  if (normalized === "midnight") {
    return "00:00";
  }

  const match = normalized.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);

  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minutes = match[2] || "00";

  if (match[3] === "pm" && hour !== 12) {
    hour += 12;
  }

  if (match[3] === "am" && hour === 12) {
    hour = 0;
  }

  return `${String(hour).padStart(2, "0")}:${minutes}`;
}

function buildMonthSequence(todayParts, count) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(todayParts.year, todayParts.month - 1 + index, 1));
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1
    };
  });
}

async function readJson(filePath, fallbackValue) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }

    throw error;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json,text/plain;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status} for ${url}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status} for ${url}`);
  }

  return response.text();
}

function absoluteUrl(value, base) {
  if (!value) {
    return null;
  }

  const normalized = value.startsWith("//") ? `https:${value}` : value;
  const url = new URL(normalized, base);
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return url.toString();
}

function normalizeUrl(value) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function cleanText(value) {
  return collapseWhitespace(
    decodeHtmlEntities(
      String(value || "")
        .replace(/<[^>]+>/g, " ")
        .replaceAll("&nbsp;", " ")
        .replaceAll("&thinsp;", " ")
        .replace(/\u00a0/g, " ")
    )
  );
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}

function collapseWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function formatClockLabel(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));

  if (!match) {
    return "";
  }

  const hour = Number(match[1]);
  const meridiem = hour < 12 ? "a.m." : "p.m.";
  return `${hour % 12 || 12}:${match[2]} ${meridiem}`;
}

function slugify(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toTag(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/^#/, "");
}

function toTitleCase(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\bTba\b/g, "TBA")
    .replace(/\bWppac\b/g, "WPPAC");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

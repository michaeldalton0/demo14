/**
 * Refreshes src/_data/sports.auto.json from ScheduleGalaxy (Section 1's
 * scheduling system). White Plains High School is school 719.
 *
 * Source shape, verified 2026-08-07:
 *   /schools/719/teams?page=N          team roster, 20 rows/page, 19 pages
 *   /schools/719/teams/{id}/schedule/ical.ics?year=YYYY
 *                                      per-team season feed. `year` is the
 *                                      school year the season STARTED in, so a
 *                                      Nov-Mar winter season lives under the
 *                                      fall year.
 *   /schools/719/teams/{id}?load_partial=1
 *                                      the schedule table the team page lazy
 *                                      loads: game type, notes, end time.
 *
 * The ICS feed is the spine (dates, opponent, home/away, one unique URL per
 * game); the partial is enrichment and is allowed to fail on its own.
 *
 * This script owns sports.auto.json and nothing else.
 *   node scripts/update-sports.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUTO_SPORTS_PATH = path.join(ROOT, "src", "_data", "sports.auto.json");

const TIME_ZONE = "America/New_York";
const USER_AGENT =
  "Mozilla/5.0 (compatible; WPCNAEventUpdater/1.0; +https://wp-cna.github.io/demo4/)";

// Overridable so the resilience path can be exercised against a dead host.
const SCHEDULE_GALAXY_BASE = (process.env.SCHEDULE_GALAXY_BASE_URL || "https://www.schedulegalaxy.com").replace(/\/$/, "");
const SCHOOL_ID = process.env.SCHEDULE_GALAXY_SCHOOL_ID || "719";

const TEAMS_MAX_PAGES = 40;
const TEAMS_PER_PAGE = 20;
const PAST_RETENTION_DAYS = 60;
const REQUEST_TIMEOUT_MS = 20000;

const SCHOOL_NAME = "White Plains High School";

// "Boys Varsity Football v. Harrison" (home) / "... @ Sleepy Hollow" (away).
const MATCHUP_PATTERN = /\s+(v\.|vs\.?|@)\s+/i;

async function main() {
  const previous = await readJson(AUTO_SPORTS_PATH, { teams: [], games: [] });
  const previousTeams = Array.isArray(previous.teams) ? previous.teams : [];
  const previousGames = Array.isArray(previous.games) ? previous.games : [];
  const previousGamesByTeam = groupByTeam(previousGames);

  const todayParts = getTodayParts();
  const keepAfter = shiftIsoDate(todayParts.iso, -PAST_RETENTION_DAYS);
  const seasonYears = seasonYearsFor(todayParts);

  let teams;

  try {
    teams = await fetchVarsityTeams();

    if (!teams.length) {
      throw new Error("No varsity teams parsed.");
    }

    console.log(`Found ${teams.length} varsity teams at school ${SCHOOL_ID}.`);
  } catch (error) {
    console.warn(`Could not refresh the team roster: ${error.message}`);

    if (!previousTeams.length) {
      throw new Error("The team roster failed and there is no prior roster to keep.");
    }

    teams = previousTeams.map((team) => ({ ...team }));
    console.warn(`Keeping the ${teams.length} teams from the previous run.`);
  }

  const collected = [];
  let refreshedTeams = 0;

  for (const team of teams) {
    const retained = retainRecentGames(previousGamesByTeam[team.id] || [], keepAfter, todayParts.iso);

    try {
      const fresh = await fetchTeamGames(team, seasonYears);

      refreshedTeams += 1;
      collected.push(...mergeWithRetained(fresh, retained, keepAfter));
    } catch (error) {
      console.warn(`Could not refresh ${team.name}: ${error.message}`);
      // Keep everything already known for this team, not just the past ones —
      // a dead fetch must never look like "the season was cancelled".
      collected.push(...(previousGamesByTeam[team.id] || []).filter((game) => gameEndDate(game) >= keepAfter));
    }
  }

  if (!refreshedTeams && !previousGames.length) {
    throw new Error("Every team schedule failed and there is no prior sports dataset to keep.");
  }

  const games = dedupeGames(collected).sort(compareGamesForOutput);
  const gameCounts = countGamesByTeam(games);
  const outputTeams = teams
    .map((team) => ({ ...team, gameCount: gameCounts[team.id] || 0 }))
    .sort(compareTeamsForOutput);

  const payload = { school: SCHOOL_NAME, schoolId: String(SCHOOL_ID), teams: outputTeams, games };

  await fs.writeFile(AUTO_SPORTS_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(
    `Wrote ${games.length} games across ${outputTeams.length} varsity teams to ${path.relative(ROOT, AUTO_SPORTS_PATH)}.`
  );
}

/** ScheduleGalaxy's `year` is the year the season started in. */
function seasonYearsFor(todayParts) {
  const currentSeason = todayParts.month >= 7 ? todayParts.year : todayParts.year - 1;
  return [currentSeason, currentSeason + 1];
}

async function fetchVarsityTeams() {
  const byId = new Map();
  let previousSignature = "";

  for (let page = 1; page <= TEAMS_MAX_PAGES; page += 1) {
    const html = await fetchText(`${SCHEDULE_GALAXY_BASE}/schools/${SCHOOL_ID}/teams?page=${page}`);
    const rows = parseTeamRows(html);

    if (!rows.length) {
      break;
    }

    // The roster pages keep returning 200 past the end, so stop when a page
    // repeats the previous one instead of trusting a "next" link.
    const signature = rows.map((row) => row.id).join(",");

    if (signature === previousSignature) {
      break;
    }

    previousSignature = signature;

    for (const row of rows) {
      if (!byId.has(row.id)) {
        byId.set(row.id, row);
      }
    }

    if (rows.length < TEAMS_PER_PAGE) {
      break;
    }
  }

  return [...byId.values()].filter((team) => team.level.toLowerCase() === "varsity").map(buildTeam);
}

function parseTeamRows(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("tr").each((_, element) => {
    const row = $(element);
    const href = row.find(`a[href*="/teams/"]`).attr("href") || "";
    const id = (href.match(/\/teams\/(\d+)/) || [])[1];

    if (!id) {
      return;
    }

    const cells = row
      .find("td")
      .map((__, cell) => cleanText($(cell).text()))
      .get();

    if (cells.length < 3) {
      return;
    }

    const [sport, level, gender] = cells;

    if (!sport || !level || !gender) {
      return;
    }

    rows.push({ id, sport, level, gender });
  });

  return rows;
}

function buildTeam(row) {
  const name = `${row.gender} ${row.level} ${row.sport}`;

  return {
    id: row.id,
    sport: row.sport,
    gender: row.gender,
    level: row.level,
    name,
    slug: slugify(name),
    sportSlug: slugify(row.sport),
    scheduleUrl: `${SCHEDULE_GALAXY_BASE}/schools/${SCHOOL_ID}/teams/${row.id}`,
    gameCount: 0
  };
}

async function fetchTeamGames(team, seasonYears) {
  const bySeason = [];
  let lastError = null;
  let succeeded = 0;

  for (const year of seasonYears) {
    try {
      const ics = await fetchText(
        `${SCHEDULE_GALAXY_BASE}/schools/${SCHOOL_ID}/teams/${team.id}/schedule/ical.ics?year=${year}`
      );
      succeeded += 1;
      bySeason.push(...parseIcsEvents(ics).map((event) => buildGame(event, team, year)).filter(Boolean));
    } catch (error) {
      lastError = error;
    }
  }

  // A team with no games posted yet is normal — an unreachable feed is not.
  if (!succeeded) {
    throw lastError || new Error("No season feeds could be fetched.");
  }

  // The partial is per-season too, so it has to be walked with the same years
  // as the feeds or next season's games lose their type and notes.
  const details = new Map();

  for (const year of seasonYears) {
    try {
      for (const [gameId, detail] of await fetchTeamScheduleDetails(team, year)) {
        details.set(gameId, detail);
      }
    } catch (error) {
      console.warn(`Schedule details unavailable for ${team.name} (${year}): ${error.message}`);
    }
  }

  return bySeason.map((game) => {
    const detail = details.get(game.gameId);

    if (!detail) {
      return game;
    }

    return {
      ...game,
      gameType: detail.gameType || game.gameType,
      notes: detail.notes || game.notes,
      endTime: detail.endTime || game.endTime,
      opponent: game.opponent || detail.opponent
    };
  });
}

async function fetchTeamScheduleDetails(team, year) {
  const html = await fetchText(
    `${SCHEDULE_GALAXY_BASE}/schools/${SCHOOL_ID}/teams/${team.id}?load_partial=1&year=${year}`
  );
  const $ = cheerio.load(html);
  const table = $("table.schedule").first();
  const scope = table.length ? table : $.root();
  const details = new Map();

  const headers = scope
    .find("tr")
    .first()
    .find("th")
    .map((_, cell) => cleanText($(cell).text()).toLowerCase())
    .get();

  const columnFor = (label) => headers.findIndex((header) => header.includes(label));
  const typeIndex = columnFor("type");
  const opponentIndex = columnFor("opponent");
  const endTimeIndex = columnFor("end time");
  const notesIndex = columnFor("notes");

  scope.find("tr").each((_, element) => {
    const row = $(element);
    const href = row.find(`a[href*="/games/"]`).attr("href") || "";
    const gameId = (href.match(/\/games\/(\d+)/) || [])[1];

    if (!gameId) {
      return;
    }

    const cells = row
      .find("td")
      .map((__, cell) => cleanText($(cell).text()))
      .get();

    const cellAt = (index) => (index >= 0 && index < cells.length ? cells[index] : "");

    details.set(gameId, {
      gameType: cellAt(typeIndex),
      opponent: cellAt(opponentIndex),
      endTime: parseClockTime(cellAt(endTimeIndex)),
      notes: cellAt(notesIndex)
    });
  });

  return details;
}

function buildGame(event, team, seasonYear) {
  const start = parseIcsDateTime(event.DTSTART);

  if (!start) {
    return null;
  }

  const url = normalizeUrl(valueOf(event.URL) || valueOf(event.UID));
  const gameId = (String(url || "").match(/\/games\/(\d+)/) || [])[1];

  if (!gameId) {
    return null;
  }

  const summary = cleanText(valueOf(event.SUMMARY));
  const { opponent, isHome } = parseMatchup(summary);
  const end = parseIcsDateTime(event.DTEND);
  const locationName = cleanText(valueOf(event.LOCATION));

  return {
    id: `sports-${gameId}`,
    gameId,
    teamId: team.id,
    teamName: team.name,
    teamSlug: team.slug,
    sport: team.sport,
    sportSlug: team.sportSlug,
    gender: team.gender,
    level: team.level,
    opponent,
    isHome,
    title: buildGameTitle(team, opponent, isHome),
    gameType: "",
    notes: "",
    startDate: start.date,
    startTime: start.time,
    endTime: end && end.date === start.date ? end.time : null,
    locationName: locationName || (isHome ? SCHOOL_NAME : ""),
    url,
    seasonYear: String(seasonYear),
    summary
  };
}

function buildGameTitle(team, opponent, isHome) {
  const versus = isHome === false ? "at" : "vs.";
  return opponent ? `${team.name} ${versus} ${opponent}` : team.name;
}

function parseMatchup(summary) {
  const match = MATCHUP_PATTERN.exec(summary);

  if (!match) {
    return { opponent: "", isHome: null };
  }

  return {
    opponent: cleanText(summary.slice(match.index + match[0].length)),
    isHome: match[1].toLowerCase() !== "@"
  };
}

/* ---------------------------------------------------------------- iCalendar */

function parseIcsEvents(text) {
  const events = [];
  let current = null;

  for (const line of unfoldIcsLines(text)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }

    if (line === "END:VEVENT") {
      if (current) {
        events.push(current);
      }

      current = null;
      continue;
    }

    if (!current) {
      continue;
    }

    const separator = line.indexOf(":");

    if (separator === -1) {
      continue;
    }

    const [name, ...parameters] = line.slice(0, separator).split(";");
    current[name.trim().toUpperCase()] = {
      value: unescapeIcsValue(line.slice(separator + 1)),
      parameters
    };
  }

  return events;
}

// RFC 5545 folds long lines by starting the continuation with a space or tab.
function unfoldIcsLines(text) {
  const lines = [];

  for (const raw of String(text || "").split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && lines.length) {
      lines[lines.length - 1] += raw.slice(1);
      continue;
    }

    lines.push(raw);
  }

  return lines;
}

function unescapeIcsValue(value) {
  return String(value || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function valueOf(property) {
  return property ? property.value : "";
}

function parseIcsDateTime(property) {
  const value = String(valueOf(property) || "").trim();
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, , isUtc] = match;

  if (!hour) {
    return { date: `${year}-${month}-${day}`, time: null };
  }

  // The school feeds carry TZID=America/New_York, so the literal clock time is
  // already local. A bare UTC stamp still has to be converted.
  if (isUtc) {
    return utcToZonedParts(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  }

  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
}

function utcToZonedParts(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  })
    .formatToParts(new Date(timestamp))
    .reduce((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

function parseClockTime(value) {
  const match = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(cleanText(value));

  if (!match) {
    return null;
  }

  const [, rawHour, minute, meridiem] = match;
  const hour = Number(rawHour) % 12 + (meridiem.toLowerCase() === "p" ? 12 : 0);

  return `${padNumber(hour)}:${minute}`;
}

/* ------------------------------------------------------------------ plumbing */

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

  return { iso: formatted, year, month, day };
}

function shiftIsoDate(isoDate, dayOffset) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

function gameEndDate(game) {
  return game.endDate || game.startDate || "";
}

function groupByTeam(games) {
  return games.reduce((accumulator, game) => {
    const teamId = game.teamId || "unknown";
    accumulator[teamId] = accumulator[teamId] || [];
    accumulator[teamId].push(game);
    return accumulator;
  }, {});
}

function countGamesByTeam(games) {
  return games.reduce((accumulator, game) => {
    accumulator[game.teamId] = (accumulator[game.teamId] || 0) + 1;
    return accumulator;
  }, {});
}

function retainRecentGames(games, keepAfter, todayIso) {
  return games.filter((game) => {
    const endDate = gameEndDate(game);
    return endDate >= keepAfter && endDate < todayIso;
  });
}

function mergeWithRetained(freshGames, previousGames, keepAfter) {
  return dedupeGames([...previousGames, ...freshGames]).filter((game) => gameEndDate(game) >= keepAfter);
}

function dedupeGames(games) {
  const byId = new Map();

  for (const game of games) {
    byId.set(game.id, game);
  }

  return [...byId.values()];
}

function compareGamesForOutput(a, b) {
  const left = `${a.startDate}${a.startTime || "00:00"}${a.title}${a.id}`;
  const right = `${b.startDate}${b.startTime || "00:00"}${b.title}${b.id}`;
  return left.localeCompare(right);
}

function compareTeamsForOutput(a, b) {
  return `${a.sport}${a.gender}${a.id}`.localeCompare(`${b.sport}${b.gender}${b.id}`);
}

async function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }

    throw error;
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/calendar,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status} for ${url}`);
  }

  return response.text();
}

function normalizeUrl(value) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).toString().replace(/\/$/, "");
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

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function slugify(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

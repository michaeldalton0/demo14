/**
 * Display layer for the varsity sports hub.
 *
 * scripts/update-sports.mjs owns sports.auto.json; this module only shapes it
 * for templates (this-week view, per-sport grouping, home/away labels). It
 * mirrors eventStore.js: derive everything here, keep the .njk files thin.
 */
let sportsData = { school: "White Plains High School", schoolId: "719", teams: [], games: [] };

try {
  sportsData = require("./sports.auto.json");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") {
    throw error;
  }
}

const TIME_ZONE = "America/New_York";
const THIS_WEEK_DAYS = 7;
const RECENT_RESULTS_LIMIT = 12;

// Swimmers and runners go to meets, golfers play matches. Getting this wrong is
// the kind of thing a parent notices immediately.
const MEET_SPORTS =
  /^(cross country|outdoor track|winter track|indoor track|swimming|swimming\/diving|diving|gymnastics|wrestling|fencing|rifle|bowling|skiing|crew)$/i;
const MATCH_SPORTS = /^(golf|tennis|badminton)$/i;

function eventNounFor(sport = "") {
  if (MEET_SPORTS.test(sport)) {
    return { noun: "meet", nounPlural: "meets" };
  }

  if (MATCH_SPORTS.test(sport)) {
    return { noun: "match", nounPlural: "matches" };
  }

  return { noun: "game", nounPlural: "games" };
}

function countLabel(count, sport) {
  const { noun, nounPlural } = eventNounFor(sport);
  return `${count} ${count === 1 ? noun : nounPlural}`;
}

function getTodayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(new Date())
    .replaceAll("/", "-");
}

function shiftIsoDate(isoDate, dayOffset) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

function compareGames(a, b) {
  return `${a.startDate}${a.startTime || "00:00"}${a.title}`.localeCompare(
    `${b.startDate}${b.startTime || "00:00"}${b.title}`
  );
}

function compareGamesDescending(a, b) {
  return compareGames(b, a);
}

function compareTeams(a, b) {
  return `${a.sport}${a.gender}`.localeCompare(`${b.sport}${b.gender}`);
}

const todayIso = getTodayIso();
const thisWeekEnd = shiftIsoDate(todayIso, THIS_WEEK_DAYS);

const teams = [...(sportsData.teams || [])]
  .map((team) => ({
    ...team,
    ...eventNounFor(team.sport),
    gameCountLabel: countLabel(team.gameCount || 0, team.sport)
  }))
  .sort(compareTeams);

const games = [...(sportsData.games || [])]
  .map((game) => {
    const status = game.startDate < todayIso ? "past" : "upcoming";
    const isScrimmage = /scrimmage/i.test(game.gameType || "");

    return {
      ...game,
      status,
      isScrimmage,
      ...eventNounFor(game.sport),
      monthKey: (game.startDate || "").slice(0, 7),
      homeAwayLabel: game.isHome === false ? "Away" : "Home",
      // The ICS location is the venue; away games name the host's field.
      venue: game.locationName || (game.isHome === false ? "Away" : "White Plains High School"),
      opponentLabel: game.opponent || "Opponent TBA",
      searchText: [game.title, game.sport, game.gender, game.opponent, game.locationName, game.gameType]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
    };
  })
  .sort(compareGames);

const upcoming = games.filter((game) => game.status === "upcoming");
const past = games.filter((game) => game.status === "past").sort(compareGamesDescending);
const thisWeek = upcoming.filter((game) => game.startDate <= thisWeekEnd);

const sportOrder = [...new Set(teams.map((team) => team.sport))].sort((a, b) => a.localeCompare(b));

const bySport = sportOrder.map((sport) => {
  const sportTeams = teams.filter((team) => team.sport === sport);
  const sportGames = games.filter((game) => game.sport === sport);
  const sportUpcoming = sportGames.filter((game) => game.status === "upcoming");

  return {
    sport,
    ...eventNounFor(sport),
    upcomingLabel: countLabel(sportUpcoming.length, sport),
    totalLabel: countLabel(sportGames.length, sport),
    sportSlug: sportTeams[0] ? sportTeams[0].sportSlug : "",
    detailUrl: `/sports/${sportTeams[0] ? sportTeams[0].sportSlug : ""}/`,
    teams: sportTeams,
    genders: [...new Set(sportTeams.map((team) => team.gender))].sort(),
    games: sportGames,
    upcoming: sportUpcoming,
    past: sportGames.filter((game) => game.status === "past").sort(compareGamesDescending),
    upcomingCount: sportUpcoming.length,
    gameCount: sportGames.length,
    hasSchedule: sportGames.length > 0
  };
});

module.exports = {
  school: sportsData.school || "White Plains High School",
  schoolId: sportsData.schoolId || "719",
  teams,
  teamCount: teams.length,
  games,
  upcoming,
  past: past.slice(0, RECENT_RESULTS_LIMIT),
  thisWeek,
  thisWeekEnd,
  todayIso,
  bySport,
  sportsWithSchedules: bySport.filter((entry) => entry.hasSchedule),
  sportsAwaitingSchedules: bySport.filter((entry) => !entry.hasSchedule),
  hasAnyGames: games.length > 0
};

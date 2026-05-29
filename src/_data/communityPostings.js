// Community postings are stored as plain data in communityPostings.json so the
// list is easy to edit by hand and safe for the approval Worker to append to.
// This module loads that data and adds the derived fields the templates use.
const rawPostings = require("./communityPostings.json").postings;

const POSTINGS_TIME_ZONE = "America/New_York";
function postingsTodayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: POSTINGS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
const todayIso = postingsTodayIso();
function isPastPosting(posting) {
  const end = posting.endDate || posting.startDate;
  return Boolean(end) && end < todayIso;
}

function toSearchText(posting) {
  return [
    posting.title,
    posting.category,
    posting.sourceLabel,
    posting.locationName,
    posting.locationAddress,
    posting.shortSummary
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function withDerivedFields(posting) {
  const detailUrl = `/posting/${posting.slug}/`;
  const monthKey = posting.startDate.slice(0, 7);

  return {
    ...posting,
    organizer: posting.sourceLabel,
    source: posting.sourceLabel,
    detailUrl,
    monthKey,
    cardActionLabel: "Posting details",
    primaryAction: {
      label: "Posting details",
      url: `${detailUrl}#about-this-posting`
    },
    searchText: toSearchText(posting)
  };
}

const all = rawPostings
  .map(withDerivedFields)
  .sort((a, b) => `${a.startDate}T${a.startTime}`.localeCompare(`${b.startDate}T${b.startTime}`));

const current = all.filter((posting) => !isPastPosting(posting));

module.exports = {
  all,
  current,
  upcoming: current,
  categories: [...new Set(current.map((posting) => posting.category))]
};

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

// Optional "Link" set in the admin; only plain http(s) addresses are used.
function externalLink(posting) {
  const url = typeof posting.externalUrl === "string" ? posting.externalUrl.trim() : "";
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  return { label: (posting.linkLabel || "").trim() || "Read more", url };
}

function withDerivedFields(posting) {
  const detailUrl = `/posting/${posting.slug}/`;
  const monthKey = posting.startDate.slice(0, 7);
  const link = externalLink(posting);

  return {
    ...posting,
    organizer: posting.sourceLabel,
    source: posting.sourceLabel,
    detailUrl,
    monthKey,
    cardActionLabel: "Posting details",
    externalLink: link,
    // With a Link, the detail page's sidebar button opens it.
    primaryAction: link || {
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

function asDate(dateString) {
  if (!dateString) return null;
  return new Date(`${dateString}T12:00:00`);
}

function formatDate(dateString, options = {}) {
  const date = asDate(dateString);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    weekday: options.includeWeekday ? "long" : undefined,
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function formatShortDate(dateString) {
  const date = asDate(dateString);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function formatTime(timeString) {
  if (!timeString) return "See details";
  const [hours, minutes] = timeString.split(":").map(Number);
  const date = new Date(2026, 0, 1, hours, minutes);
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = function (eleventyConfig) {
  const pathPrefix = process.env.SITE_PATH_PREFIX || "/";
  const outputDir = process.env.SITE_OUTPUT_DIR || "_site";

  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  // Content admin (Sveltia CMS) — copy verbatim, don't run it through templating.
  eleventyConfig.addPassthroughCopy({ "src/admin": "admin" });
  eleventyConfig.ignores.add("src/admin/**");

  eleventyConfig.addFilter("absoluteUrl", (path = "", base = "") => {
    if (!path) return base;
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    return `${base.replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
  });

  eleventyConfig.addFilter("withPrefix", (path = "") => {
    if (!path) return pathPrefix === "/" ? "/" : pathPrefix;
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    const cleanPrefix = pathPrefix === "/" ? "" : pathPrefix.replace(/\/$/, "");
    const cleanPath = path === "/" ? "/" : `/${String(path).replace(/^\/+/, "")}`;
    if (!cleanPrefix) return cleanPath;
    if (cleanPath === "/") return `${cleanPrefix}/`;
    // Idempotent: if the path already carries the prefix, do not add it again.
    if (cleanPath === cleanPrefix || cleanPath.startsWith(`${cleanPrefix}/`)) return cleanPath;
    return `${cleanPrefix}${cleanPath}`;
  });

  eleventyConfig.addFilter("dateLabel", (event) => {
    if (!event || !event.startDate) return "";
    if (!event.endDate || event.endDate === event.startDate) {
      return formatDate(event.startDate, { includeWeekday: true });
    }
    return `${formatDate(event.startDate, { includeWeekday: true })} to ${formatDate(event.endDate)}`;
  });

  eleventyConfig.addFilter("shortDateLabel", (event) => {
    if (!event || !event.startDate) return "";
    if (!event.endDate || event.endDate === event.startDate) {
      return formatShortDate(event.startDate);
    }
    return `${formatShortDate(event.startDate)} - ${formatShortDate(event.endDate)}`;
  });

  eleventyConfig.addFilter("timeLabel", (event) => {
    if (!event || !event.startTime) return "See details";
    if (!event.endTime) return formatTime(event.startTime);
    return `${formatTime(event.startTime)} - ${formatTime(event.endTime)}`;
  });

  eleventyConfig.addFilter("monthYearLabel", (monthKey = "") => {
    const [year, month] = monthKey.split("-").map(Number);
    if (!year || !month) return monthKey;
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric"
    }).format(new Date(year, month - 1, 1));
  });

  // Escape text and turn any http(s) web address in it into a clickable link
  // (opens in a new tab). Trailing punctuation stays outside the link.
  function linkifyText(text = "") {
    const s = String(text);
    const re = /https?:\/\/[^\s<>"]+/gi;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      const url = m[0].replace(/[.,;:!?)\]'’”]+$/, "");
      out += escapeHtml(s.slice(last, m.index));
      out += `<a class="text-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
      last = m.index + url.length;
      re.lastIndex = last;
    }
    return out + escapeHtml(s.slice(last));
  }

  eleventyConfig.addFilter("linkify", (text = "") => linkifyText(text));

  eleventyConfig.addFilter("paragraphs", (text = "") => {
    return String(text)
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${linkifyText(p)}</p>`)
      .join("");
  });

  eleventyConfig.addFilter("json", (value) => JSON.stringify(value));

  return {
    pathPrefix,
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: outputDir
    }
  };
};

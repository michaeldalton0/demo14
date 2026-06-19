const fs = require("fs");
const path = require("path");

const imagePath = "/assets/img/maps/white-plains-neighborhood-map-clean.png";
const svgPath = path.join(
  __dirname,
  "../assets/img/maps/white-plains-neighborhood-map-050526-pastel.svg"
);
const svgSource = fs.readFileSync(svgPath, "utf8");
const viewBoxMatch = svgSource.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);

function getPathD(slug) {
  const match = svgSource.match(
    new RegExp(`<path id="neighborhood-${slug}"[^>]*?\\sd="([^"]+)"`, "s")
  );

  if (!match) {
    throw new Error(`Missing map region path for neighborhood slug: ${slug}`);
  }

  return match[1].replace(/\s+/g, " ").trim();
}

function buildRegion(slug) {
  return {
    slug,
    pathD: getPathD(slug)
  };
}

const featuredSlugs = [
  "fisher-hill",
  "battle-hill",
  "highlands",
  "prospect-park",
  "north-broadway",
  "good-counsel",
  "westminster-ridge",
  "eastview",
  "gedney-farms",
  "saxon-woods",
  "rosedale",
];

const allRegionSlugs = [
  ...new Set(
    [...svgSource.matchAll(/<path id="neighborhood-([^"]+)"/g)].map((match) => match[1])
  )
];

module.exports = {
  imagePath,
  imageVersion: "20260506-pastel-map",
  imageAlt:
    "Pastel neighborhood map of White Plains with neighborhood boundaries and labels.",
  imageWidth: 1190,
  imageHeight: 1684,
  viewBoxWidth: viewBoxMatch ? Number(viewBoxMatch[1]) : 595.276,
  viewBoxHeight: viewBoxMatch ? Number(viewBoxMatch[2]) : 841.89,
  featuredSlugs,
  regions: featuredSlugs.map(buildRegion),
  allRegions: allRegionSlugs.map(buildRegion)
};

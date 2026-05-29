const neighborhoodStore = require("./neighborhoodStore");
const featuredNeighborhoodMap = require("./featuredNeighborhoodMap");

const mapRegionBySlug = new Map(
  (featuredNeighborhoodMap.allRegions || featuredNeighborhoodMap.regions || []).map(function (region) {
    return [region.slug, region];
  })
);

// Membership is CMS-driven: a neighborhood is featured (top section + map outline)
// when its `member` flag is true in neighborhoods.json. No hardcoded list.
const items = neighborhoodStore.all
  .filter(function (n) { return n.member === true; })
  .sort(function (a, b) { return a.name.localeCompare(b.name); })
  .map(function (n) {
    const mapRegion = mapRegionBySlug.get(n.slug) || null;
    return {
      slug: n.slug,
      name: n.name,
      teaser: n.displayTeaser,
      bodyParagraphs: (n.detailParagraphs || []).filter(function (x) { return x && String(x).trim(); }),
      profilePlaceholder: n.profilePlaceholder,
      guideImageLabel: n.guideImageLabel || "Image coming soon",
      hero: n.displayHero || null,
      resourceLinks: n.resourceLinks || [],
      association: n.association || null,
      detailUrl: n.detailUrl,
      reviewNote: "",
      aliases: [],
      isPlaceholder: false,
      mapRegionSlug: mapRegion ? n.slug : "",
      mapRegion: mapRegion ? { pathD: mapRegion.pathD, points: mapRegion.points || "" } : null
    };
  });

module.exports = {
  imagePath: featuredNeighborhoodMap.imagePath,
  imageVersion: featuredNeighborhoodMap.imageVersion,
  imageAlt:
    "White Plains neighborhood map with the neighborhoods currently represented through WPCNA outlined.",
  imageWidth: featuredNeighborhoodMap.imageWidth,
  imageHeight: featuredNeighborhoodMap.imageHeight,
  viewBoxWidth: featuredNeighborhoodMap.viewBoxWidth,
  viewBoxHeight: featuredNeighborhoodMap.viewBoxHeight,
  includeGedneyMeadows: true,
  items: items,
  mappedItems: items.filter(function (i) { return i.mapRegion; })
};

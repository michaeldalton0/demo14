# WPCNA Site — Builder AI Handoff

**Repo:** `never-nude/wpcna` (working copy at `~/wpcna`)
**Stack:** Eleventy 3.1.5 + Nunjucks, vanilla CSS, no JS framework
**Dev server:** `npm start` → http://localhost:8080
**Build:** `npm run build` → outputs to `_site/`
**Deploy target:** GitHub Pages (`never-nude.github.io/wpcna/`); a separate `wpcna-2` destination is planned

---

## Context

This is a community guide for the White Plains Council of Neighborhood Associations (WPCNA). It replaces an older GoDaddy/wsimg-hosted site at `wp-cna.org`. The migration goal is **no user-facing forwards back to the old site** — every external WPCNA resource should live as a native page here.

Owner: Michael Dalton (President). The WPCNA Contact form sends to `michael@mdalton.com` and CCs `michael.kushman@gmail.com`. Site email links display `info@wpcna.org`, while their underlying `mailto:` BCCs `michael@mdalton.com` (configured via `site.emailMailto` in `src/_data/site.js`).

---

## What's already done

### Native pages (no more wp-cna.org redirects)
- `/agendas/` — meeting agendas + 17 archived minutes (`src/_data/agendas.json`, `src/agendas/index.njk`). PDFs are still hot-linked from `img1.wsimg.com` because the sandbox can't fetch them — see "TODO" below.
- `/workshops/` — workshop materials and slides (`src/workshops/index.njk`)
- `/neighborhood-map/` — hosts the WP neighborhood map image (`src/neighborhood-map/index.njk`)
- `src/_data/resources.json` and `src/_data/events.json` — all 8 wp-cna.org URLs repointed to internal pages
- `src/_data/navigation.json` — Agendas added
- `src/_includes/components/footer.njk` — removed "main WPCNA site" link, added internal column
- `src/_includes/components/macros.njk` — `resourceCard` and `eventCard` macros now distinguish internal vs external links

### Neighborhood images
- 43 neighborhoods total. **13 have real Wikimedia photos**, marked `status: "wikimedia"` in `src/_data/neighborhood-heroes.json`. Do not touch these.
- The other **30 currently use placeholder SVGs** at `src/assets/img/neighborhoods/generated/{slug}.svg` — group-keyed gradient + skyline silhouette + neighborhood name. Marked `status: "generated"`.
- The `neighborhoodCard` macro in `src/_includes/components/macros.njk` renders `<img>` inside `.neighborhood-card-img` (16:9, object-fit cover, hover scale). Detail pages already render hero + attribution.
- Verified end-to-end: `{"total":43,"loaded":43,"broken":[],"uniqueSrcs":43}` on `/neighborhoods/`.

### Email
- `src/_data/site.js` defines `email: "info@wpcna.org"` (display) and `emailMailto: "info@wpcna.org?bcc=michael%40mdalton.com"` (href).
- All four `mailto:` links in the site (footer, about, workshops, home) use `{{ site.emailMailto }}` for the href and `{{ site.email }}` for the visible text.

### Dev workflow
- `restart-dev.command` — double-clickable Finder script that kills port 8080 and restarts `npm start`. Use this when the dev server gets out of sync after large file changes. The Eleventy `--serve` watcher does not always pick up bulk writes from outside its process.

---

## TODO — what the next builder should pick up

### 1. Source real neighborhood photos (HIGH PRIORITY)
The 30 placeholder SVGs are functional but visually paltry. The previous AI's sandbox couldn't reach github / wikimedia / image hosts; **you should have unrestricted web access — use it.**

**Task:** For every entry in `src/_data/neighborhood-heroes.json` where `status == "generated"`, find a freely-licensed photo (CC0, CC-BY, CC-BY-SA, or public domain) that actually depicts that neighborhood.

**Sources, in order of preference:**
1. Wikimedia Commons — search `"[Neighborhood name] White Plains"` and `"White Plains New York [landmark]"`
2. Flickr Commons / Flickr CC-licensed
3. Library of Congress, NY Public Library Digital Collections
4. Local government / open-data portals, Geograph-style projects

**For each photo:**
1. Download to `src/assets/img/neighborhoods/photos/{slug}.jpg` (or `.png`). Resize to ~1600px wide, JPEG quality ~82, strip EXIF.
2. Update that entry in `neighborhood-heroes.json`:
   - `localFilename`: `photos/{slug}.jpg`
   - `status`: `"photo"`
   - `sourceUrl`, `attributionText`, `attributionUrl`, `license`, `licenseUrl` — fill from the source page
   - `attributionRequired`: `true` for CC-BY/BY-SA, `false` for CC0/PD
   - `altText`: real description of the image
3. If no suitable freely-licensed photo exists for a neighborhood after a real search, leave its `generated/{slug}.svg` in place and note it in `TODO-neighborhood-photos.md` with what you tried.

**Rules:**
- The image must actually depict that neighborhood — a recognizable street, park, landmark, vista, building. Generic downtown shots only acceptable for the `Central White Plains` group.
- No AI-generated images.
- No images without a clear free license. Don't grab from Google Images without tracing back to the source and license.
- Do NOT touch the 13 entries with `status: "wikimedia"`.
- Do NOT change the macro, CSS, or templates — only the JSON and image files.

**Verify:** `npm run build`, then load `/neighborhoods/` and several detail pages. All 43 cards should load; attributions should appear on detail pages. Commit on branch `feature/neighborhood-photos`.

### 2. Self-host PDFs and assets currently on `img1.wsimg.com`
The agendas, workshop slides, and neighborhood map still hot-link to the old GoDaddy CDN. The previous AI's sandbox couldn't fetch them. You should:
1. Grep for `wsimg.com` across `src/_data/` and `src/`.
2. For each URL, download the file, store it under `src/assets/files/` (PDFs) or `src/assets/img/` (images), and rewrite the JSON/template references to the local path.
3. Verify each link still resolves after build.

### 3. Push to `wpcna-2` deploy target
The user wants the site to land at a separate `wpcna-2` GitHub destination (so the existing `wpcna` repo stays untouched while this version is reviewed). You'll need to:
1. Confirm with the user whether `wpcna-2` is a new repo on `never-nude` or somewhere else.
2. Adjust `package.json` build scripts and the GitHub Pages workflow as needed.
3. The `pathPrefix` is controlled by `SITE_PATH_PREFIX` / `CANONICAL_PATH_PREFIX` env vars in `src/_data/site.js` — set these correctly for the new repo name.

### 4. Audit remaining external links
The user said "we don't want to forward users to the old site." Beyond wp-cna.org (done), they may also want internalized:
- `cityofwhiteplains.com` references
- `calendar.whiteplainslibrary.org` references

Don't act on these without checking with the user first — these are legitimate external civic resources, not the old site, and may be intentional outbound links.

---

## Architecture notes

### Data layer
- All structured content lives in `src/_data/*.json` (or `.js`). Templates read from these — never hard-code lists in `.njk`.
- `src/_data/neighborhoodStore.js` builds derived data: `heroBySlug`, `byGroup`, etc. The hero `imagePath` is constructed as `/assets/img/neighborhoods/${hero.localFilename}`.
- `src/_data/site.js` is the global config; environment-aware for `pathPrefix`.

### Templates
- Layouts: `src/_includes/layouts/`
- Components: `src/_includes/components/macros.njk` (cards, hero, etc.)
- Pages: `src/{page}/index.njk` — frontmatter sets layout + permalink
- Always pipe paths through the `withPrefix` filter so they work under both `/` (local) and `/wpcna/` (deployed).

### Sports hub (`/sports/`)

Varsity schedules for White Plains High School, boys and girls, every sport.

- **Source:** ScheduleGalaxy (Section 1's scheduling system), school **719**. The useful
  endpoints, none of which are documented:
  - `/schools/719/teams?page=N` — roster, 20 rows/page, 19 pages, 378 teams (42 varsity).
    Pages past the end still return 200 with repeated rows, so the importer stops when a
    page repeats rather than trusting a "next" link.
  - `/schools/719/teams/{id}/schedule/ical.ics?year=YYYY` — the full-season feed, and the
    only one that works. `year` is the year the season *started* in, so a Nov–Mar winter
    season lives under the fall year. (`/teams/{id}/ical` is a 404, as are
    `/schools/719/calendar`, `/feed`, `/leagues`, and `/tournaments`.)
  - `/schools/719/teams/{id}?load_partial=1` — the lazy-loaded schedule table. Enrichment
    only: game type (Scrimmage / Regular Season / playoff rounds), notes, end time. It is
    allowed to fail on its own without losing the game.
- **Script:** `scripts/update-sports.mjs` (`npm run update-sports`). Owns
  `src/_data/sports.auto.json` and nothing else. Per-team try/catch; a failed fetch keeps
  that team's previously known games rather than reading as "season cancelled". Output has
  no timestamps and stable sort keys, so running it twice produces no diff.
- **Data:** `src/_data/sports.auto.json` (`teams` + `games`). `src/_data/sportsStore.js` is
  the display layer — this-week view, per-sport grouping, home/away labels, and the
  game/meet/match noun per sport.
- **Pages:** `src/sports/index.njk` (hub) and `src/sports/sport.njk` (per-sport, paginated
  over `sportsStore.sportsWithSchedules`).
- **Entry points:** deliberately *not* in the top nav — it is already full. Reachable from
  the events page callout, the homepage "Useful pages" card (`resources.json`), and the
  footer.
- **Marquee games → events list:** the `sports` source in `scripts/update-events.mjs` reads
  `sports.auto.json` and promotes only home varsity football, Section 1 rivals (New
  Rochelle, Scarsdale, Stepinac, Mamaroneck, Mount Vernon, Harrison), senior nights, and postseason
  games, under the new **Sports** category. Non-playoff picks are capped at 6/month;
  **playoff games bypass the cap entirely and are marked `featured`** so the events-page
  curation layer cannot drop them. Scrimmages are excluded unless postseason.
- **Workflow:** `.github/workflows/update-events.yml` runs `npm run update-sports` once a
  day (the `15 4 * * *` cron and any manual dispatch), before `npm run update-events`.
  Events still refresh 3×/day; the sports sweep is ~126 requests so it does not need to.

> **Upstream caveat:** ScheduleGalaxy is sparsely populated by the athletic department. As
> of 2026-08-07 only **11 varsity games across 6 of 42 teams** were posted, and prior
> seasons are just as thin — this is not a scraping gap. The hub lists all 42 teams and
> fills in on its own as schedules are entered.

### Build quirks
- Running `npm run build` from inside the sandbox can throw `EPERM` on the static-asset passthrough copy because of file ownership across the mount boundary. The HTML still builds correctly (154 files) — this error is harmless during verification but should not appear when run from the user's own shell.
- If the dev server stops reflecting changes, run `./restart-dev.command` rather than fighting the watcher.

### CSS
- Single file: `src/assets/css/styles.css`. No preprocessor, no Tailwind.
- Custom properties at the top define brand colors. Stick to those.
- Card components: `.neighborhood-card`, `.resource-card`, `.event-card`. The neighborhood card's image wrapper is `.neighborhood-card-img` (16:9).

---

## Things to NOT do

- Don't reintroduce links to `wp-cna.org` — this is the old site we're replacing.
- Don't share documents or change file permissions on the user's behalf (Cowork rule).
- Don't push to `main` of `never-nude/wpcna` without explicit user approval — work on branches, open PRs.
- Don't modify the email display string — `info@wpcna.org` is the public address. The BCC is in the `mailto:` href only.
- Don't touch the 13 `wikimedia`-status neighborhood entries.
- Don't replace any of the placeholder SVGs with AI-generated images.

---

## Quick verification checklist before handing back

- [ ] `npm run build` completes (EPERM on passthrough is OK if running in sandbox; should not appear in a normal shell)
- [ ] `/neighborhoods/` listing shows all 43 cards with images
- [ ] At least 5 random neighborhood detail pages load with their unique hero + attribution
- [ ] Footer "Email WPCNA" link, when inspected, contains `bcc=michael%40mdalton.com` but visible text is `info@wpcna.org`
- [ ] No occurrences of `wp-cna.org` in `src/` (grep)
- [ ] No occurrences of `wsimg.com` in `src/` (after task #2)
- [ ] All internal links resolve under both `/` and `/wpcna/` path prefixes

---

## User communication style

Mike (the user) prefers terse, direct responses. Don't over-explain. Show file paths and verification output rather than narrating intent. Ask before taking destructive or scope-expanding actions, but don't ask permission for the obvious next step inside an already-approved task.

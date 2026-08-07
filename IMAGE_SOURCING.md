# Image Sourcing Notes

This file documents the imagery currently used in the WPCNA site refresh and explains which assets are placeholders.

## Rights-Clear White Plains Photography

### Homepage hero and about page image

- File: `src/assets/img/photos/white-plains-main.jpeg`
- Source: user-provided local image
- Original file: `/Users/michael/Desktop/white plains (1).jpeg`
- Notes: Copied into the project for the current hero and about image on March 25, 2026, replacing the earlier local version.

### Alternate Rights-Clear White Plains Photography

These assets remain in the project and can be reused later, but they are not the current featured hero:

- File: `src/assets/img/photos/white-plains-downtown-street.jpg`
- Source page: <https://commons.wikimedia.org/wiki/File:Downtown_White_Plains,_NY_2010-05-20.jpg>
- Title: `Downtown White Plains, NY 2010-05-20`
- Creator: `Paul Sableman`
- License: `CC BY 2.0`
- Notes: Downloaded from Wikimedia Commons and resized locally for site use.

- File: `src/assets/img/photos/white-plains-downtown-hero.jpg`
- Source page: <https://commons.wikimedia.org/wiki/File:Downtown_White_Plains_from_the_NE.jpg>
- Title: `Downtown White Plains from the NE`
- Creator: `Ynsalh`
- License: `CC BY-SA 4.0`

- File: `src/assets/img/photos/white-plains-station.jpg`
- Source page: <https://commons.wikimedia.org/wiki/File:White_Plains_MNRR_Station%3B_2018-10-16%3B_02.jpg>
- Title: `White Plains MNRR Station; 2018-10-16; 02`
- Creator: `DanTD`
- License: `CC BY-SA 4.0`

### Sports hub hero

- File: `src/assets/img/heroes/cna-sports-hero.jpg`
- Source page: <https://commons.wikimedia.org/wiki/File:Athletics_track_start_line_numbers_1,_2,_3.jpg>
- Title: `Athletics track start line numbers 1, 2, 3`
- Creator: `Santeri Viinamäki`
- License: `CC BY-SA 4.0` — attribution is required and is rendered in the credit
  bar directly under the hero on `/sports/`. Do not remove it.
- Notes: Downloaded from Wikimedia Commons and resized to 2200px wide on
  2026-08-07. Chosen deliberately over game photography: an orange all-weather
  track with white lane markings carries **no team, no uniform, and no logo at
  all**, and its orange/white reads as White Plains' own colours (orange, black,
  white) rather than some other school's. It is also sport-neutral, which suits
  a hub covering 42 varsity teams across every sport.
- Rejected alternatives: a Merrimack College night game (blue/white kit and a
  blue-and-yellow midfield mark — clashed with the WPHS palette) and a Celina
  High School night game (school name painted across the endzone and spelled out
  on flags). If this is ever swapped, keep the bar there: no legible branding,
  and nothing that reads as another school's colours.

## Neighborhood Placeholder Graphics

The homepage neighborhood section currently uses locally created placeholder graphics:

- `src/assets/img/neighborhoods/fisher-hill.svg`
- `src/assets/img/neighborhoods/the-highlands.svg`
- `src/assets/img/neighborhoods/gedney-farms.svg`
- `src/assets/img/neighborhoods/rosedale.svg`

These are intentionally temporary. They avoid using uncertain or copyrighted real-estate photography while keeping the layout ready for future neighborhood-specific imagery.

## Neighborhood Hero System

Neighborhood detail pages now use a vetted hero-image mapping:

- Data file: `src/_data/neighborhood-heroes.json`
- Audit and source table: `NEIGHBORHOOD_IMAGE_AUDIT.md`
- Local assets: `src/assets/img/neighborhoods/`

This system uses a mix of:

- direct neighborhood matches where Wikimedia Commons surfaced a clearly relevant image
- landmark-based matches where a nearby civic or institutional image better represents the neighborhood
- one approved White Plains-wide fallback image where no safe neighborhood-specific option was strong enough

Attribution is shown directly on neighborhood pages below the hero image.

### Fisher Hill local photos

- Files:
  - `src/assets/img/neighborhoods/photos/fisher-hill-card.jpg`
  - `src/assets/img/neighborhoods/photos/fisher-hill-hero.jpg`
- Source: user-provided local Fisher Hill photos
- Original files:
  - `/Users/michael/Pictures/Photos Library.photoslibrary/resources/derivatives/3/30A44E85-116D-4AC0-A999-E8B9A6AC8F0F_1_105_c.jpeg`
  - `/Users/michael/Pictures/Photos Library.photoslibrary/resources/derivatives/3/3A62C0FA-86F4-4767-8BFE-320E1D470F92_1_105_c.jpeg`
- Notes:
  - The street view is used on the Fisher Hill neighborhoods-page card and the Fisher Hill detail-page hero.
  - The archway/house image remains in the project as an alternate local Fisher Hill photo.

## Replacement Workflow

1. Source a neighborhood image with clearly reusable rights.
2. Save it under `src/assets/img/neighborhoods/`.
3. Update the corresponding item in `src/_data/neighborhood-heroes.json`.
4. Regenerate or update `NEIGHBORHOOD_IMAGE_AUDIT.md` so the audit table stays in sync.
5. Replace the placeholder entry in this file with the real attribution details if the sourcing notes change.

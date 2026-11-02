# Congo Basin flooded-forest explorer, 2015–2025

**Live site:** https://benpoulter.github.io/alos-palsar/

An interactive map of seasonally flooded forest in the central Congo Basin, built on the ALOS-2 PALSAR-2 ScanSAR inundation maps of Rosenqvist et al. (2026). It runs entirely in the browser as a static site, so GitHub Pages can host it.

The page works at two resolutions:

- **Overview (2 km).** About 11 MB of pre-computed summaries ship in `data/`: the share of each 2 km cell that was flooded on each of the 99 radar passes, plus the 2015–2025 duration map at 400 m.
- **Detail (100 m), streamed from Zenodo.** When you zoom in, click a spot or draw a region, the page fetches only the 512 × 512-pixel tiles it needs from the original GeoTIFFs. It reads them straight out of the yearly zip files in the Zenodo record using HTTP range requests, and nothing is re-hosted. This works because the zips store their files uncompressed (so every tile is a plain byte range), Zenodo's file API allows cross-origin range requests, and one request can carry many ranges. `data/tile_index.bin` records where every tile sits inside each zip.

## What you can do

- Scrub or play through all 99 passes, and switch to the 2015–2025 flood-duration layer.
- Zoom in to see the original 100 m classes: flooded forest, open water, submerged vegetation, exposed river banks and masks. You can also colour flooded pixels by how they were mapped: seen directly, filled from neighbouring passes, or filled from a hydrological proxy.
- Click a spot to get the exact flooded area of the surrounding 1 km block on every pass, plus an 11 × 9 calendar of the clicked pixel's class.
- Draw a region up to 40 tiles (about 300 × 300 km) to get exact 100 m flooded area for every pass. Larger regions fall back to the 2 km summary.
- Compare up to four selections as every-pass, yearly-mean or seasonal-cycle charts, with a Theil–Sen trend, a Mann–Kendall p-value and the gap-filled share. **Copy series as CSV** exports the numbers.

## Put it on GitHub Pages

1. Create a new repository on GitHub, public or private with Pages enabled.
2. Upload everything in this folder, keeping the structure: `index.html`, `app.js`, `.nojekyll`, `data/`, `scripts/` and this README. Either drag the files onto the repository's **Add file → Upload files** page, or run:
   ```
   git init && git add . && git commit -m "Flooded-forest explorer"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. In the repository, open **Settings → Pages**, set **Source** to *Deploy from a branch*, choose `main` and `/ (root)`, then save.
4. After a minute or two the site is live at `https://<you>.github.io/<repo>/`.

To try it locally first, run `python -m http.server` in this folder and open http://localhost:8000. Opening `index.html` directly from disk won't work, because browsers block `fetch` on `file://` pages.

## Limits worth knowing

- **Zenodo request limit.** Zenodo allows about 133 requests per minute per visitor. Each request carries many tile ranges, so typical use stays well inside the limit:
  - a spot click is 11 requests (one per year);
  - a region is about 11 requests per tile row;
  - a map view is 1 request.

  If the limit is reached, the page pauses and resumes automatically, and the sidebar shows how many requests are left.
- **Data volume.** Tiles average about 10 KB compressed. A spot click streams about 1 MB, and a 40-tile region about 40 MB.
- **Record version.** The tile index is tied to Zenodo record `22981938` (v1.0). If the authors publish a new version, rerun `scripts/build_data.py` and commit the new `data/`.
- **Browser support.** The page needs `DecompressionStream`, which is available in current Chrome, Edge, Firefox and Safari.

## Reading the numbers

Flooded-forest area is the area of pixels classed as inundated vegetation (class 1), weighted by each pixel's true area at its latitude. Two points from the dataset's own assessment, which covers South America, matter:

- The radar misses about 40% of flooded forest (58.5% producer's accuracy) while rarely raising false alarms (97% user's accuracy), so areas are minimum estimates.
- The Central Africa products have **not** yet been validated separately.

The 2 km summary reproduces regional totals within 0.1% but carries about ±2% noise per cell from rounding. Every value shown with a **100 m** badge is an exact pixel count.

## Rebuilding `data/`

`scripts/build_data.py` downloads the record (about 1.6 GB) and regenerates every file in `data/` except `context.json`, which holds Natural Earth borders and rivers clipped to the map.

## Credits and licences

- Inundation data: Rosenqvist, A., Rosenqvist, J., Oakes, G., Bunting, P., Hardy, A., Hilarides, L., Hodge, J., Kobayashi, K., Isoguchi, O., & Tadono, T. (2026). *Forested Wetland Inundation Extent and Change over Time (2015–2025) – South America N & Central Africa* (v1.0). Zenodo. https://doi.org/10.5281/zenodo.22981938. CC-BY 4.0. Original ALOS-2 PALSAR-2 data © JAXA/EORC. The files in `data/` are derived from it and carry the same licence and attribution.
- Borders and rivers: Natural Earth (public domain).
- Code: add the licence of your choice, for example MIT.

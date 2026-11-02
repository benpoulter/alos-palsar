"""Rebuild everything in ../data from the Zenodo record (Central Africa).

    pip install rasterio tifffile numpy shapely
    python build_data.py --download      # ~1.6 GB into ./zenodo
    python build_data.py                 # writes ../data

Outputs
  tile_index.bin / .json  byte offset + length of every 512x512 tile of every 100 m
                          extent GeoTIFF *inside its yearly zip* (zips are "stored",
                          so a tile is a plain byte range of the zip on Zenodo).
  cube_2km.bin            gzip, uint8, cell-major [cell*99 + pass]: share of each 2 km
                          cell classed as inundated vegetation, in 2% steps (0-50),
                          rounded with random dithering so regional sums are unbiased.
  gapfill_4km.bin         same for gap-filled IV (band 2 >= 21) at 4 km.
  domain_2km.bin          gzip, packed bits: 2 km cells inside the mapping domain.
  duration_400m.bin       gzip, uint8: all-years duration (0-99), nearest-sampled 1/8.
  cube_meta.json          pass dates and grid geometry.
  context.json            Natural Earth borders/rivers clipped to the map (build separately).

The tile index is tied to record 22981938 (v1.0). A new version of the record means new
file URLs and offsets: rerun this script and update zipUrl in tile_index.json.
"""
import argparse, gzip, json, os, re, struct, subprocess, zipfile
import numpy as np, rasterio, tifffile
from rasterio.enums import Resampling

REC = "https://zenodo.org/api/records/22981938/files/{name}/content"
YEARS = range(2015, 2026)
ZIP = "alos2_inund-ext_c-africa_{y}_100m_v1-0.zip"
DUR = "alos2_inund-dur_c-africa_All-Years_20150105-20251226_50m_v1-0.tif"
SRC, OUT = "zenodo", os.path.join(os.path.dirname(__file__), "..", "data")
H, W, B = 12375, 21375, 10           # 100 m grid, 1 km aggregation block
HC, WC = -(-H // B), -(-W // B)


def download():
    os.makedirs(SRC, exist_ok=True)
    for name in [ZIP.format(y=y) for y in YEARS] + [DUR]:
        dst = os.path.join(SRC, name)
        if not os.path.exists(dst):
            print("downloading", name)
            subprocess.run(["curl", "-sSL", "-o", dst, REC.format(name=name)], check=True)


def members():
    for y in YEARS:
        zp = os.path.join(SRC, ZIP.format(y=y))
        z = zipfile.ZipFile(zp)
        for info in sorted((i for i in z.infolist() if i.filename.endswith(".tif")), key=lambda i: i.filename):
            yield y, zp, info


def tile_index():
    offs, cnts, meta = [], [], []
    for y, zp, info in members():
        with open(zp, "rb") as f:
            f.seek(info.header_offset)
            n, e = struct.unpack("<HH", f.read(30)[26:30])
        base = info.header_offset + 30 + n + e
        page = tifffile.TiffFile(zipfile.ZipFile(zp).open(info.filename)).pages[0]
        assert page.compression == 8 and page.predictor == 1 and page.tilewidth == 512
        offs.append(np.array(page.dataoffsets, np.int64) + base)
        cnts.append(np.array(page.databytecounts, np.int64))
        m = re.search(r"_c(\d+)_(\d{8})-(\d{8})_", info.filename)
        meta.append(dict(cycle=int(m[1]), start=m[2], end=m[3], year=y, file=os.path.basename(info.filename)))
    O, C = np.array(offs), np.array(cnts)
    np.concatenate([O.astype("<u4").ravel(), C.astype("<u4").ravel()]).tofile(os.path.join(OUT, "tile_index.bin"))
    json.dump(dict(cycles=meta, ntiles=O.shape[1], tilesAcross=42, tilesDown=25, tile=512, width=W, height=H,
                   lon0=8, lat0=5, px=3.2 / 3600, zipUrl=REC.format(name=ZIP.replace("{y}", "{year}"))),
              open(os.path.join(OUT, "tile_index.json"), "w"), separators=(",", ":"))
    return meta


def block_sum(mask, f):
    h, w = mask.shape
    z = np.zeros((-(-h // f) * f, -(-w // f) * f), np.uint32)
    z[:h, :w] = mask
    return z.reshape(z.shape[0] // f, f, z.shape[1] // f, f).sum((1, 3))


def cubes(meta):
    T = len(meta)
    iv1 = np.zeros((T, HC, WC), np.uint8)
    gf1 = np.zeros((T, HC, WC), np.uint8)
    dom1 = None
    for t, (y, zp, info) in enumerate(members()):
        with rasterio.open(f"/vsizip/{zp}/{info.filename}") as s:
            for r0 in range(0, H, 1000):
                a = s.read(window=((r0, min(H, r0 + 1000)), (0, W)))
                c, p = a[0], a[1]
                rr = slice(r0 // B, r0 // B + -(-c.shape[0] // B))
                iv1[t, rr] = block_sum(c == 1, B)
                gf1[t, rr] = block_sum((c == 1) & (p >= 21), B)
                if t == 0:
                    if dom1 is None:
                        dom1 = np.zeros((HC, WC), np.uint16)
                    dom1[rr] = block_sum(((c >= 1) & (c <= 4)) | (c == 8), B)
        print("aggregated", info.filename)
    rng = np.random.default_rng(0)
    h2, w2 = -(-HC // 2), -(-WC // 2)
    q = np.zeros((T, h2, w2), np.uint8)
    for t in range(T):
        frac = block_sum(iv1[t], 2) / 400.0
        q[t] = np.floor(frac * 50 + rng.random(frac.shape)).clip(0, 50)
    gzip.open(os.path.join(OUT, "cube_2km.bin"), "wb", 9).write(np.ascontiguousarray(q.transpose(1, 2, 0)).tobytes())
    g = np.stack([np.round(block_sum(gf1[t], 4) / 1600 * 50) for t in range(T)]).astype(np.uint8)
    gzip.open(os.path.join(OUT, "gapfill_4km.bin"), "wb", 9).write(np.ascontiguousarray(g.transpose(1, 2, 0)).tobytes())
    dom = (block_sum(dom1, 2) > 0).astype(np.uint8)
    gzip.open(os.path.join(OUT, "domain_2km.bin"), "wb", 9).write(np.packbits(dom).tobytes())
    with rasterio.open(os.path.join(SRC, DUR)) as s:
        bg = s.read(1, out_shape=(s.height // 8, s.width // 8), resampling=Resampling.nearest)
    gzip.open(os.path.join(OUT, "duration_400m.bin"), "wb", 9).write(bg.tobytes())
    json.dump(dict(cycles=[{k: m[k] for k in ("cycle", "start", "end")} for m in meta], w=w2, h=h2, dx=20 * 3.2 / 3600,
                   lon0=8, lat0=5, w4=g.shape[2], h4=g.shape[1], dx4=40 * 3.2 / 3600, bgw=bg.shape[1], bgh=bg.shape[0],
                   bgext=[8, 27, -6, 5]), open(os.path.join(OUT, "cube_meta.json"), "w"), separators=(",", ":"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true")
    a = ap.parse_args()
    if a.download:
        download()
    else:
        os.makedirs(OUT, exist_ok=True)
        cubes(tile_index())

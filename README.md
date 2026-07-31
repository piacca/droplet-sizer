# Droplet Sizer

A browser-based tool for measuring water-in-oil droplet diameters from microscopy images. Everything runs client-side (via [OpenCV.js](https://docs.opencv.org/4.x/df/d0a/tutorial_js_intro.html)) — no images are uploaded to a server, so it works entirely offline once loaded and can be hosted for free as a static site (e.g. GitHub Pages).

## Usage

1. Open `index.html` (or the hosted URL) in a browser.
2. **Upload** a microscopy image (PNG/JPG/TIFF).
3. **Calibrate the scale**: click "Draw scale line", drag along a reference of known length (e.g. a scale bar on the image), then enter that real-world length and unit.
4. **Tune detection**: adjust the sliders (min/max diameter, minimum distance between droplets, edge sensitivity, detection strictness) and click "Run detection". Detected droplets are outlined in red on the image.
5. **Review results**: summary statistics, a diameter histogram, and a per-droplet table appear. Click "Download CSV" to export all measured diameters (in both pixels and µm).

Detection uses a [Hough Circle Transform](https://docs.opencv.org/4.x/d3/de5/tutorial_js_houghcircles.html), which works best on droplets that are reasonably circular, in focus, and not too heavily overlapping. If results are off, re-tune the sliders and re-run — no need to re-upload or re-calibrate.

## Running locally

This is a static site with no build step. Any local web server works, e.g.:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. (Opening `index.html` directly via `file://` can hit browser restrictions on loading OpenCV.js — a local server avoids that.)

## Limitations

- Detection is circle-based; well-separated and moderately overlapping droplets work best. Heavily overlapping/merged droplets are unreliable — see the overlap tuning tips below.
- Scale calibration and detection parameters are per-image; batch processing across many images isn't supported yet.
- Accuracy depends on image quality (focus, contrast, scale bar clarity).
- TIFF support ([UTIF.js](https://github.com/photopea/UTIF.js)) is decoded entirely client-side. Only the first frame of a multi-page/stack TIFF is used. Common 8-bit and 16-bit grayscale scientific TIFFs are supported, but unusual variants (e.g. some OME-TIFF metadata, float samples) may not decode correctly — if a TIFF fails or looks wrong, try re-exporting as PNG (e.g. in ImageJ/Fiji: File → Save As → PNG) as a fallback.

## Tips for overlapping droplets

The Hough Circle Transform detects circles from edge arcs, not full silhouettes, so it tolerates *partial* overlap reasonably well without any changes. If overlapping droplets are being missed or merged:

- Lower **"min distance between centers"** — a high value actively suppresses detecting two droplets whose centers are close together.
- Lower **"detection strictness"** — overlapping droplets have less visible edge arc, so they generate a weaker signal and need a lower threshold to register.
- Narrow the min/max diameter range around your droplets' actual size — this reduces false positives that a lower strictness threshold would otherwise let through.

For *heavily* overlapping/merged droplets where individual boundaries are barely visible, circle-fitting approaches (including this one) fundamentally struggle — that needs a different algorithm (e.g. watershed segmentation), not just parameter tuning.

## License

MIT — see [LICENSE](LICENSE).

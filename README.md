# Darts Score Trainer

Find where to aim on a dartboard to score the most, given how your darts spread. Measure your own throws and get your personal best aim point.

**[▶ Try it online](https://louismayonove.github.io/Darts-Score-Trainer/)**

## What it does

Treble 20 is the highest-scoring bed on the board, but it sits between the 1 and the 5. If your darts spread widely, aiming at it costs more in misses than it earns in trebles. The app models each throw as

```
landing = aim + bias + error,   error ~ N(0, Σ),   Σ = [[σx², ρσxσy], [ρσxσy, σy²]]
```

and computes the expected score of one dart for every aim point on the board.

- **Explore:** a live heatmap of the expected score. Drag the σx, σy, tilt (ρ) and bias sliders, or pick a preset, and the best aim point (★) follows. It's checked against 200,000 simulated throws. Hover to read any point, click to pin it and compare it with T20, T19, T18 and the bull. Settings are kept in the URL, so a link reproduces the view.
- **Measure:** throw 30 or more darts at one target, then click (or tap) where each landed. The app fits your bias, spread and tilt, draws your 1σ and 2σ ellipses, and gives *your* best aim. Your darts are saved in the browser and can be saved or loaded as CSV.
- **Compare:** several spreads side by side, with an optional shared colour scale.
- **How it works:** the model, the maths and some results.

Everything runs in your browser and no data is sent anywhere.

## Run locally

No build step and no dependencies. Serve the folder with any static server:

```sh
python -m http.server
```

Then open http://localhost:8000. (Opening `index.html` straight from disk won't work: browsers block module workers on `file://` URLs.)

## Publish with GitHub Pages

The site is plain static files, so GitHub Pages serves it as is:

1. Push this repository to GitHub.
2. In **Settings → Pages**, set **Source** to *Deploy from a branch*, choose `main` and `/ (root)`, and save.
3. After a minute the app is live at `https://<user>.github.io/<repository>/`.

`.nojekyll` tells Pages to serve the files without running Jekyll.

## How the maths works

The expected-score map is the board's score function convolved with the Gaussian. It is computed on a grid (1 mm by default, 0.5 mm for very tight spreads) with a 2D FFT:

- The score is zero off the board, so a circular convolution is exact once the FFT size keeps the wrapped copies away from the part of the map shown.
- The Gaussian's spectrum is written in closed form (Poisson summation), so each map costs one inverse FFT. The board's spectrum is cached. A map takes about 20 ms, which keeps the sliders live. The work runs in a Web Worker.
- Each board cell holds the score averaged over a 4×4 sub-grid (only cells crossed by a wire need it). Point sampling would put ring edges up to half a cell off and overstate tight spreads by about 0.5 points per dart. With averaging, the map stays within 0.1 points of a Monte Carlo simulation.

The fit uses the sample mean (bias) and the unbiased sample covariance (σx, σy, ρ), as `numpy.cov` does.

## Python reference

The app is a browser port of [`reference/dart_heatmap.py`](reference/dart_heatmap.py), a command-line tool with the same model (interactive sliders, measuring, comparing patterns). Run it with [uv](https://docs.astral.sh/uv/):

```sh
uv run reference/dart_heatmap.py -i                 # live sliders
uv run reference/dart_heatmap.py --measure          # click your throws
uv run reference/dart_heatmap.py --throws examples/sample_throws.csv
```

The CSV format is shared: a CSV saved by the app loads in the script, and the other way round. [`examples/sample_throws.csv`](examples/sample_throws.csv) holds 40 simulated darts thrown at the bull, to try *Load CSV*.

## Code overview

```
index.html, style.css     page and layout
js/main.js                tabs, URL routing, theme
js/worker.js              computes maps off the main thread
js/core/                  engine: board geometry, FFT, expected-score maps,
                          statistics (fit, Monte Carlo), CSV, colour map
js/ui/                    board renderer, Explore / Measure / Compare tabs
tests/                    unit tests and the cross-check against Python
reference/                the original Python script
```

## Tests

```sh
node --test "tests/*.test.mjs"   # unit tests (Node 18+)
node tests/crosscheck.mjs        # full maps vs the Python script (needs uv)
```

The cross-check runs the Python script on ten spreads and compares the full maps, with the board point-sampled as in Python. The JS engine with the truncated kernel matches it to float32 precision. The default analytic kernel stays within 0.003 points, and both pick the same best aim. GitHub Actions runs both on every push.

## License

[MIT](LICENSE)

# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "numpy",
#     "matplotlib",
# ]
# ///
"""
Dart aiming heatmap.

For every aim point on a standard steel-tip dartboard, compute the expected
score of one dart when the landing point follows a 2D Gaussian centred on the
aim point:

    landing = aim + N(0, Sigma),   Sigma = [[sx^2,      rho*sx*sy],
                                            [rho*sx*sy, sy^2     ]]

The expected-score map is the board's score function convolved with the
Gaussian (done exactly on a grid with an FFT). The best aim point is marked,
and is checked with a Monte Carlo simulation of actual throws.

Usage examples
--------------
    uv run dart_heatmap.py -i                           # live sliders (interactive)
    uv run dart_heatmap.py --measure                    # click your own throws at
                                                        # the bull, get YOUR best aim
    uv run dart_heatmap.py --measure --aim T20          # ...thrown at T20 instead
    uv run dart_heatmap.py --throws throws.csv          # reload a saved session
    uv run dart_heatmap.py                              # compare default patterns
    uv run dart_heatmap.py --sigma 20 20                # one pattern, 20 mm each axis
    uv run dart_heatmap.py --sigma 15 40 --sigma 40 15  # compare two patterns
    uv run dart_heatmap.py --sigma 25 35 --rho 0.4      # correlated (tilted) spread
    uv run dart_heatmap.py --sigma 30 30 --show-throws  # overlay simulated darts
    uv run dart_heatmap.py --save heatmap.png           # save instead of only showing

All distances are in millimetres (board radius to outer double wire = 170 mm).
"""

import argparse

import matplotlib.pyplot as plt
import matplotlib.patheffects as pe
import numpy as np

# ---------------------------------------------------------------------------
# Board geometry (regulation dimensions, mm)
# ---------------------------------------------------------------------------
R_BULLSEYE = 6.35       # inner bull (50)
R_BULL = 15.9           # outer bull (25)
R_TRIPLE_IN = 99.0
R_TRIPLE_OUT = 107.0
R_DOUBLE_IN = 162.0
R_DOUBLE_OUT = 170.0

# Sector numbers clockwise starting from the top
SECTORS = np.array([20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
                    3, 19, 7, 16, 8, 11, 14, 9, 12, 5])


def sector_index(x, y):
    """Index into SECTORS for points (x, y); 20 is centred straight up."""
    theta = np.degrees(np.arctan2(y, x))           # 0 deg = +x, counter-clockwise
    clockwise_from_top = (90.0 - theta + 9.0) % 360.0
    return (clockwise_from_top // 18).astype(int) % 20


def score(x, y):
    """Vectorised score of a dart landing at (x, y)."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    r = np.hypot(x, y)
    s = SECTORS[sector_index(x, y)].astype(float)

    s = np.where((r >= R_TRIPLE_IN) & (r < R_TRIPLE_OUT), 3 * s, s)
    s = np.where((r >= R_DOUBLE_IN) & (r < R_DOUBLE_OUT), 2 * s, s)
    s = np.where(r >= R_DOUBLE_OUT, 0.0, s)
    s = np.where(r < R_BULL, 25.0, s)
    s = np.where(r < R_BULLSEYE, 50.0, s)
    return s


def region_name(x, y):
    """Human-readable name of the board region at (x, y), e.g. 'T19'."""
    r = float(np.hypot(x, y))
    if r < R_BULLSEYE:
        return "Bullseye (50)"
    if r < R_BULL:
        return "Outer bull (25)"
    if r >= R_DOUBLE_OUT:
        return "Off board"
    n = SECTORS[sector_index(np.array(x), np.array(y))]
    if R_TRIPLE_IN <= r < R_TRIPLE_OUT:
        return f"T{n}"
    if R_DOUBLE_IN <= r < R_DOUBLE_OUT:
        return f"D{n}"
    return f"S{n}"


# ---------------------------------------------------------------------------
# Expected score map
# ---------------------------------------------------------------------------
def gaussian_kernel(sx, sy, rho, res, n_sigma=4.0):
    """Discrete, normalised 2D Gaussian on a grid with spacing `res` (mm)."""
    half = int(np.ceil(n_sigma * max(sx, sy) / res))
    ax = np.arange(-half, half + 1) * res
    X, Y = np.meshgrid(ax, ax)
    cov = np.array([[sx**2, rho * sx * sy], [rho * sx * sy, sy**2]])
    inv = np.linalg.inv(cov)
    q = inv[0, 0] * X**2 + 2 * inv[0, 1] * X * Y + inv[1, 1] * Y**2
    k = np.exp(-0.5 * q)
    return k / k.sum()


def _fast_len(n):
    """Smallest 2^a * 3^b * 5^c >= n (FFTs are much faster at these sizes)."""
    best = 1 << int(np.ceil(np.log2(n)))
    p5 = 1
    while p5 < best:
        p35 = p5
        while p35 < best:
            m = p35
            while m < n:
                m *= 2
            best = min(best, m)
            p35 *= 3
        p5 *= 5
    return best


_FFT_CACHE = {}


def fft_convolve_same(a, k, cache_key=None):
    """2D linear convolution of `a` with odd-sized kernel `k`, same size as `a`.

    If `cache_key` is given, the FFT of `a` is cached under it, so repeated
    calls with the same `a` (e.g. live slider updates) only transform `k`.
    """
    shape = (_fast_len(a.shape[0] + k.shape[0] - 1),
             _fast_len(a.shape[1] + k.shape[1] - 1))
    key = (cache_key, shape)
    if cache_key is not None and key in _FFT_CACHE:
        A = _FFT_CACHE[key]
    else:
        A = np.fft.rfft2(a, shape)
        if cache_key is not None:
            _FFT_CACHE[key] = A
    out = np.fft.irfft2(A * np.fft.rfft2(k, shape), shape)
    r0 = (k.shape[0] - 1) // 2
    c0 = (k.shape[1] - 1) // 2
    return out[r0:r0 + a.shape[0], c0:c0 + a.shape[1]]


_SCORE_CACHE = {}


def expected_score_map(sx, sy, rho=0.0, res=0.5, view=180.0):
    """
    Return (axis, E) where E[i, j] is the expected score when aiming at
    (axis[j], axis[i]). Only the square [-view, view]^2 is returned.

    The Gaussian is symmetric about its centre, so convolution equals the
    correlation E(a) = sum_z S(a + z) p(z) that we actually want. Everything
    outside the board scores 0, so zero padding is exact.
    """
    key = (res, view)
    if key not in _SCORE_CACHE:
        ax = np.arange(-view, view + res / 2, res)
        X, Y = np.meshgrid(ax, ax)
        _SCORE_CACHE[key] = (ax, score(X, Y))
    ax, S = _SCORE_CACHE[key]
    K = gaussian_kernel(sx, sy, rho, res)
    E = fft_convolve_same(S, K, cache_key=key)
    return ax, E


def monte_carlo(aim, sx, sy, rho, n=200_000, rng=None):
    """Simulate n throws at `aim`; return (mean score, std error, landing points)."""
    rng = np.random.default_rng() if rng is None else rng
    cov = [[sx**2, rho * sx * sy], [rho * sx * sy, sy**2]]
    pts = rng.multivariate_normal(aim, cov, size=n)
    s = score(pts[:, 0], pts[:, 1])
    return s.mean(), s.std(ddof=1) / np.sqrt(n), pts


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------
WIRE = dict(color="white", lw=0.7, alpha=0.9,
            path_effects=[pe.Stroke(linewidth=1.6, foreground="black", alpha=0.45),
                          pe.Normal()])


def draw_board_wires(ax):
    from matplotlib.collections import LineCollection

    t = np.linspace(0, 2 * np.pi, 200)
    segs = [np.column_stack([r * np.cos(t), r * np.sin(t)])
            for r in (R_BULLSEYE, R_BULL, R_TRIPLE_IN, R_TRIPLE_OUT,
                      R_DOUBLE_IN, R_DOUBLE_OUT)]
    for k in range(20):
        ang = np.radians(90 - 9 - 18 * k)          # sector boundaries
        u = np.array([np.cos(ang), np.sin(ang)])
        segs.append(np.array([R_BULL * u, R_DOUBLE_OUT * u]))
    # One collection draws far faster than 26 separate lines (matters for
    # live slider updates).
    ax.add_collection(LineCollection(
        segs, colors=WIRE["color"], linewidths=WIRE["lw"], alpha=WIRE["alpha"],
        path_effects=WIRE["path_effects"], zorder=3))
    for k, n in enumerate(SECTORS):
        ang = np.radians(90 - 18 * k)              # sector centres
        ax.text(186 * np.cos(ang), 186 * np.sin(ang), str(n),
                ha="center", va="center", fontsize=9, color="#222222",
                fontweight="bold")


def plot_pattern(ax, sx, sy, rho, res, show_throws, rng):
    axis, E = expected_score_map(sx, sy, rho, res)
    i, j = np.unravel_index(np.argmax(E), E.shape)
    best = np.array([axis[j], axis[i]])
    best_val = E[i, j]

    mc_mean, mc_se, pts = monte_carlo(best, sx, sy, rho, rng=rng)

    lim = axis[-1]
    im = ax.imshow(E, origin="lower", extent=[-lim, lim, -lim, lim],
                   cmap="Blues", interpolation="bilinear")
    draw_board_wires(ax)

    if show_throws:
        sub = pts[:400]
        ax.scatter(sub[:, 0], sub[:, 1], s=6, c="#D9480F", alpha=0.55,
                   linewidths=0, zorder=4, label="simulated darts")

    ax.plot(*best, marker="*", ms=20, mfc="#FFD43B", mec="black", mew=1.2,
            zorder=5, label="best aim")
    ax.annotate(f"{best_val:.2f}", best, xytext=(10, 10),
                textcoords="offset points", fontsize=10, fontweight="bold",
                color="black",
                bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="none",
                          alpha=0.85), zorder=6)

    rho_txt = f", ρ={rho:g}" if rho else ""
    ax.set_title(f"σx={sx:g} mm, σy={sy:g} mm{rho_txt}\n"
                 f"best: aim {region_name(*best)} at ({best[0]:.0f}, {best[1]:.0f}) "
                 f"→ {best_val:.2f} pts/dart", fontsize=10)
    ax.set_xlim(-200, 200)
    ax.set_ylim(-200, 200)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)

    cb = plt.colorbar(im, ax=ax, fraction=0.046, pad=0.02)
    cb.set_label("Expected score per dart")
    cb.outline.set_visible(False)

    print(f"sx={sx:>5g}  sy={sy:>5g}  rho={rho:>4g} | best aim "
          f"({best[0]:7.1f}, {best[1]:7.1f}) {region_name(*best):<16} "
          f"E={best_val:6.2f} | Monte Carlo {mc_mean:6.2f} +/- {mc_se:.2f}")
    return ax


def best_aim(axis, E):
    i, j = np.unravel_index(np.argmax(E), E.shape)
    return np.array([axis[j], axis[i]]), E[i, j]


def interactive(sx0=20.0, sy0=20.0, rho0=0.0, res=1.0, seed=0, show_throws=False,
                bias=(0.0, 0.0), measured=None):
    """Single board with sliders for sx, sy, rho; the heatmap updates live.

    bias:     mean landing offset (mm) from the aim point. With a bias, the
              heatmap is shifted so each pixel still means "expected score
              when *aiming* here", and the star is where you should aim.
    measured: optional (n, 2) array of your recorded landing points, drawn
              as small black crosses for reference.
    """
    from matplotlib.widgets import Button, CheckButtons, Slider

    bias = np.asarray(bias, dtype=float)
    rng = np.random.default_rng(seed)
    # Fixed standard-normal draws, so the throw cloud morphs smoothly
    # instead of jumping randomly when the sliders move.
    z = rng.standard_normal((400, 2))

    fig = plt.figure(figsize=(8, 9))
    ax = fig.add_axes([0.05, 0.25, 0.78, 0.68])
    cax = fig.add_axes([0.85, 0.30, 0.025, 0.58])

    # Widen the computed area by the bias so the shifted map still covers
    # the whole visible board.
    view = 200.0 + float(np.ceil(np.abs(bias).max()))
    axis, E = expected_score_map(sx0, sy0, rho0, res, view)
    lim = axis[-1]
    im = ax.imshow(E, origin="lower", extent=[-lim, lim, -lim, lim],
                   cmap="Blues", interpolation="bilinear")
    draw_board_wires(ax)
    throws = ax.scatter([], [], s=6, c="#D9480F", alpha=0.55, linewidths=0,
                        zorder=4)
    if measured is not None and len(measured):
        ax.scatter(measured[:, 0], measured[:, 1], s=18, marker="x",
                   c="black", linewidths=0.9, zorder=4, label="your darts")
    star, = ax.plot([], [], marker="*", ms=22, mfc="#FFD43B", mec="black",
                    mew=1.2, zorder=5, ls="none")
    label = ax.annotate("", (0, 0), xytext=(10, 10), textcoords="offset points",
                        fontsize=10, fontweight="bold", zorder=6,
                        bbox=dict(boxstyle="round,pad=0.25", fc="white",
                                  ec="none", alpha=0.85))
    ax.set_xlim(-200, 200)
    ax.set_ylim(-200, 200)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)
    cb = fig.colorbar(im, cax=cax)
    cb.set_label("Expected score per dart")
    cb.outline.set_visible(False)

    s_x = Slider(fig.add_axes([0.18, 0.16, 0.55, 0.03]), "σx (mm)",
                 1, 80, valinit=float(np.clip(sx0, 1, 80)), valstep=0.5)
    s_y = Slider(fig.add_axes([0.18, 0.11, 0.55, 0.03]), "σy (mm)",
                 1, 80, valinit=float(np.clip(sy0, 1, 80)), valstep=0.5)
    s_r = Slider(fig.add_axes([0.18, 0.06, 0.55, 0.03]), "ρ",
                 -0.9, 0.9, valinit=float(np.clip(rho0, -0.9, 0.9)),
                 valstep=0.05)
    chk = CheckButtons(fig.add_axes([0.80, 0.10, 0.16, 0.06]), ["throws"],
                       [show_throws])
    btn = Button(fig.add_axes([0.80, 0.04, 0.16, 0.045]), "Reset")

    def update(_=None):
        sx, sy, rho = s_x.val, s_y.val, s_r.val
        _, E = expected_score_map(sx, sy, rho, res, view)
        centre, val = best_aim(axis, E)      # best place for darts to centre
        best = centre - bias                 # where to aim to centre there

        im.set_data(E)
        im.set_extent([-lim - bias[0], lim - bias[0],
                       -lim - bias[1], lim - bias[1]])
        im.set_clim(E.min(), E.max())
        cb.update_normal(im)
        star.set_data([best[0]], [best[1]])
        label.xy = best
        label.set_text(f"{val:.2f}")

        if chk.get_status()[0]:
            cov = np.array([[sx**2, rho * sx * sy], [rho * sx * sy, sy**2]])
            pts = centre + z @ np.linalg.cholesky(cov).T
            throws.set_offsets(pts)
        else:
            throws.set_offsets(np.empty((0, 2)))

        bias_txt = (f", bias ({bias[0]:+.0f}, {bias[1]:+.0f}) mm"
                    if np.any(bias) else "")
        ax.set_title(f"σx={sx:g} mm, σy={sy:g} mm, ρ={rho:g}{bias_txt}\n"
                     f"best: aim {region_name(*best)} at "
                     f"({best[0]:.0f}, {best[1]:.0f}) → {val:.2f} pts/dart",
                     fontsize=11)
        fig.canvas.draw_idle()

    def reset(_):
        for s in (s_x, s_y, s_r):
            s.reset()

    s_x.on_changed(update)
    s_y.on_changed(update)
    s_r.on_changed(update)
    chk.on_clicked(update)
    btn.on_clicked(reset)
    update()

    try:
        fig.canvas.manager.set_window_title("Expected dart score by aim point")
    except AttributeError:          # headless backends have no window
        pass
    # Keep widget references alive (they stop responding if garbage-collected)
    fig._widgets = (s_x, s_y, s_r, chk, btn)
    return fig


# ---------------------------------------------------------------------------
# Measuring your own distribution
# ---------------------------------------------------------------------------
def target_point(name):
    """Board coordinates (mm) of a named target: 'bull', 'T20', 'D16', 'S5'
    (centre of the big outer single), or explicit 'x,y'."""
    s = name.strip().upper()
    if s in ("BULL", "BULLSEYE", "DB", "50", "25", "SB"):
        return np.array([0.0, 0.0])
    if "," in s:
        x, y = (float(v) for v in s.split(","))
        return np.array([x, y])
    radii = {"T": (R_TRIPLE_IN + R_TRIPLE_OUT) / 2,
             "D": (R_DOUBLE_IN + R_DOUBLE_OUT) / 2,
             "S": (R_TRIPLE_OUT + R_DOUBLE_IN) / 2}
    if s[0] in radii and s[1:].isdigit() and int(s[1:]) in SECTORS:
        k = int(np.where(SECTORS == int(s[1:]))[0][0])
        ang = np.radians(90 - 18 * k)
        return radii[s[0]] * np.array([np.cos(ang), np.sin(ang)])
    raise ValueError(f"unknown target {name!r} (use bull, T20, D16, S5 or x,y)")


def board_image(res=0.5, view=200.0):
    """RGB image of a dartboard in real colours (helps when clicking throws)."""
    ax = np.arange(-view, view + res / 2, res)
    X, Y = np.meshgrid(ax, ax)
    r = np.hypot(X, Y)
    even = sector_index(X, Y) % 2 == 0          # the 20 sector is black/red
    black, cream = np.array([0.13, 0.13, 0.13]), np.array([0.96, 0.91, 0.78])
    red, green = np.array([0.85, 0.15, 0.15]), np.array([0.10, 0.55, 0.25])
    img = np.where(even[..., None], black, cream)
    ring = ((r >= R_TRIPLE_IN) & (r < R_TRIPLE_OUT)) | \
           ((r >= R_DOUBLE_IN) & (r < R_DOUBLE_OUT))
    img = np.where((ring & even)[..., None], red, img)
    img = np.where((ring & ~even)[..., None], green, img)
    img = np.where((r < R_BULL)[..., None], green, img)
    img = np.where((r < R_BULLSEYE)[..., None], red, img)
    img = np.where((r >= R_DOUBLE_OUT)[..., None], np.array([0.93] * 3), img)
    return img, view


def fit_gaussian(points, aim):
    """Fit landing points (n, 2) thrown at `aim`.

    Returns bias (mean offset from aim), sx, sy, rho.
    """
    pts = np.asarray(points, dtype=float)
    if len(pts) < 3:
        raise ValueError("need at least 3 throws to fit a distribution")
    bias = pts.mean(axis=0) - np.asarray(aim, dtype=float)
    cov = np.cov(pts, rowvar=False)               # unbiased (n - 1)
    sx, sy = np.sqrt(np.diag(cov))
    rho = cov[0, 1] / (sx * sy) if sx > 0 and sy > 0 else 0.0
    return bias, float(sx), float(sy), float(rho)


def save_throws(path, points, aim_name):
    np.savetxt(path, np.asarray(points), delimiter=",", fmt="%.2f",
               header=f"aim={aim_name}\nx_mm,y_mm", comments="# ")


def load_throws(path):
    """Read a throws CSV: x,y columns in mm (origin = bull centre, y up).
    Returns (points, aim_name or None). An 'aim=...' comment line sets the aim."""
    aim = None
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith("#"):
                body = line.lstrip("#").strip()
                if body.lower().startswith("aim="):
                    aim = body[4:].strip()
                continue
            try:
                x, y = (float(v) for v in line.split(",")[:2])
            except ValueError:
                continue                          # header such as x_mm,y_mm
            rows.append((x, y))
    return np.array(rows).reshape(-1, 2), aim


def measure_ui(aim_name, aim_pt):
    """Window where you click where each dart landed.

    Left click: add a dart. Right click / Undo: remove the last one.
    Close the window or press Done when finished.
    Returns (fig, points_list); the list fills in while the window is open.
    """
    from matplotlib.widgets import Button

    pts = []
    img, view = board_image()
    fig = plt.figure(figsize=(8, 8.6))
    ax = fig.add_axes([0.05, 0.12, 0.9, 0.8])
    ax.imshow(img, origin="lower", extent=[-view, view, -view, view],
              interpolation="nearest")
    draw_board_wires(ax)
    ax.plot(*aim_pt, marker="+", ms=28, mew=2.5, color="#00B4D8", zorder=5)
    ax.plot(*aim_pt, marker="o", ms=10, mfc="none", mew=1.5, color="#00B4D8",
            zorder=5)
    dots = ax.scatter([], [], s=40, marker="x", c="#FFD43B", linewidths=2,
                      zorder=6,
                      path_effects=[pe.Stroke(linewidth=3.5, foreground="black"),
                                    pe.Normal()])
    ax.set_xlim(-200, 200)
    ax.set_ylim(-200, 200)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)

    def refresh(msg=""):
        dots.set_offsets(np.array(pts).reshape(-1, 2))
        hint = msg or ("left-click where each dart landed · right-click undoes "
                       "· aim for 30+ darts")
        ax.set_title(f"Throw at {aim_name} (blue cross) — {len(pts)} darts "
                     f"recorded\n{hint}", fontsize=11)
        fig.canvas.draw_idle()

    def on_click(event):
        if event.inaxes is not ax or event.xdata is None:
            return
        tb = getattr(fig.canvas, "toolbar", None)
        if tb is not None and getattr(tb, "mode", ""):
            return                        # zoom/pan tool active
        if event.button == 1:
            pts.append((event.xdata, event.ydata))
        elif event.button == 3 and pts:
            pts.pop()
        refresh()

    def undo(_):
        if pts:
            pts.pop()
        refresh()

    def clear(_):
        pts.clear()
        refresh()

    def done(_):
        if len(pts) < 3:
            refresh("need at least 3 darts before finishing")
            return
        plt.close(fig)

    fig.canvas.mpl_connect("button_press_event", on_click)
    b_undo = Button(fig.add_axes([0.20, 0.03, 0.17, 0.05]), "Undo")
    b_clear = Button(fig.add_axes([0.415, 0.03, 0.17, 0.05]), "Clear")
    b_done = Button(fig.add_axes([0.63, 0.03, 0.17, 0.05]), "Done")
    b_undo.on_clicked(undo)
    b_clear.on_clicked(clear)
    b_done.on_clicked(done)
    fig._widgets = (b_undo, b_clear, b_done)
    try:
        fig.canvas.manager.set_window_title("Record your throws")
    except AttributeError:
        pass
    refresh()
    return fig, pts


def expected_at(axis, E, centre):
    """Expected score (from map E) when darts are centred at `centre`."""
    j = int(np.clip(np.round((centre[0] - axis[0]) / (axis[1] - axis[0])),
                    0, len(axis) - 1))
    i = int(np.clip(np.round((centre[1] - axis[0]) / (axis[1] - axis[0])),
                    0, len(axis) - 1))
    return E[i, j]


def report_fit(points, aim_name, aim_pt, res):
    """Fit, print a summary and return (bias, sx, sy, rho)."""
    bias, sx, sy, rho = fit_gaussian(points, aim_pt)
    axis, E = expected_score_map(sx, sy, rho, res)
    centre, val = best_aim(axis, E)
    best = centre - bias
    n = len(points)
    print(f"\n{n} darts thrown at {aim_name}")
    print(f"  bias (mean miss):  x {bias[0]:+.1f} mm, y {bias[1]:+.1f} mm "
          f"(+x = right, +y = up)")
    print(f"  spread:            sx {sx:.1f} mm, sy {sy:.1f} mm, rho {rho:+.2f}")
    if n < 20:
        print(f"  note: only {n} darts — estimates are rough; 30+ is better")
    if sx > 80 or sy > 80 or abs(rho) > 0.9:
        print("  note: the sliders top out at sigma 80 mm and |rho| 0.9; "
              "the live view clips to that range")
    for name in ("T20", "T19", "bull"):
        t = target_point(name)
        print(f"  aim at {name:<5} -> {expected_at(axis, E, t + bias):5.2f} "
              f"pts/dart")
    print(f"  BEST: aim at ({best[0]:.0f}, {best[1]:.0f}) mm, "
          f"{region_name(*best)} -> {val:.2f} pts/dart\n")
    return bias, sx, sy, rho


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sigma", nargs=2, type=float, action="append",
                   metavar=("SX", "SY"),
                   help="horizontal and vertical std dev in mm (repeatable)")
    p.add_argument("--rho", type=float, default=0.0,
                   help="correlation between x and y errors, in (-1, 1)")
    p.add_argument("--res", type=float, default=0.5,
                   help="grid resolution in mm (default 0.5)")
    p.add_argument("--show-throws", action="store_true",
                   help="overlay simulated darts thrown at the best point")
    p.add_argument("--seed", type=int, default=0, help="Monte Carlo seed")
    p.add_argument("--save", metavar="FILE", help="save the figure to FILE")
    p.add_argument("--no-show", action="store_true", help="don't open a window")
    p.add_argument("-i", "--interactive", action="store_true",
                   help="one board with live sliders for σx, σy and ρ "
                        "(first --sigma, if given, sets the starting values)")
    p.add_argument("-m", "--measure", action="store_true",
                   help="record your own throws by clicking on a board, then "
                        "fit your distribution and show your best aim")
    p.add_argument("--throws", metavar="CSV",
                   help="load recorded landing points (x_mm,y_mm) instead of "
                        "clicking, then fit and show your best aim")
    p.add_argument("--aim", default=None,
                   help="target you threw at while measuring: bull (default), "
                        "T20, D16, S5 or x,y in mm")
    p.add_argument("--out", metavar="CSV",
                   help="where --measure saves your throws "
                        "(default: throws_<date-time>.csv)")
    args = p.parse_args()

    if not -1 < args.rho < 1:
        p.error("--rho must be strictly between -1 and 1")

    if args.measure or args.throws:
        if args.measure and args.throws:
            p.error("use either --measure or --throws, not both")
        res = args.res if args.res != 0.5 else 1.0
        if args.throws:
            points, file_aim = load_throws(args.throws)
            aim_name = args.aim or file_aim or "bull"
        else:
            aim_name = args.aim or "bull"
        try:
            aim_pt = target_point(aim_name)
        except ValueError as e:
            p.error(str(e))

        if args.measure:
            mfig, pts = measure_ui(aim_name, aim_pt)
            plt.show()                       # blocks until Done / closed
            points = np.array(pts).reshape(-1, 2)
            if len(points):
                from datetime import datetime
                out = args.out or datetime.now().strftime(
                    "throws_%Y%m%d-%H%M%S.csv")
                save_throws(out, points, aim_name)
                print(f"saved {len(points)} throws to {out} "
                      f"(reload with --throws {out})")

        if len(points) < 3:
            p.error(f"need at least 3 throws to fit, got {len(points)}")
        bias, sx, sy, rho = report_fit(points, aim_name, aim_pt, res)
        fig = interactive(sx, sy, rho, res, args.seed, args.show_throws,
                          bias=bias, measured=points)
        if args.save:
            fig.savefig(args.save, dpi=150)
            print(f"saved {args.save}")
        if not args.no_show:
            plt.show()
        return

    if args.interactive:
        sx0, sy0 = args.sigma[0] if args.sigma else (20.0, 20.0)
        # Coarser default grid so the update keeps up with slider drags
        res = args.res if args.res != 0.5 else 1.0
        fig = interactive(sx0, sy0, args.rho, res, args.seed, args.show_throws)
        if args.save:
            fig.savefig(args.save, dpi=150)
            print(f"saved {args.save}")
        if not args.no_show:
            plt.show()
        return

    patterns = args.sigma or [(5, 5), (15, 15), (30, 30), (50, 50),
                              (15, 45), (45, 15)]
    rng = np.random.default_rng(args.seed)

    n = len(patterns)
    cols = min(n, 3)
    rows = int(np.ceil(n / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(5.6 * cols, 5.4 * rows),
                             squeeze=False)
    for ax, (sx, sy) in zip(axes.flat, patterns):
        plot_pattern(ax, sx, sy, args.rho, args.res, args.show_throws, rng)
    for ax in axes.flat[n:]:
        ax.axis("off")

    fig.suptitle("Expected dart score by aim point (2D Gaussian throw spread)",
                 fontsize=13)
    fig.tight_layout()
    if args.save:
        fig.savefig(args.save, dpi=150)
        print(f"saved {args.save}")
    if not args.no_show:
        plt.show()


if __name__ == "__main__":
    main()

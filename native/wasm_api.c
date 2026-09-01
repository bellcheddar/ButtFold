/* The streaming API the browser's Web Worker drives. PLAN.md section 5.4, milestone 2.
 *
 * The physics lives in go_model_fold.c and is NOT edited. This file is additive: it
 * `#include`s that translation unit and re-exposes its existing routines with a
 * start/step/read shape, because a browser cannot use the CLI's "run to completion and
 * write a file" shape - the whole point is that frames arrive while the fold is happening.
 *
 * Including the .c rather than linking against it is deliberate and is what keeps the
 * vendored file untouched: everything interesting in there (`forces`, `model_build`,
 * `gauss`, `rng_state`) is `static`, so there is nothing to link to. `main` is renamed by
 * the macro below rather than by editing the file, and the module is built with
 * `--no-entry`, so the CLI's main is compiled, unreachable, and never called.
 *
 * The integration loop here is a transcription of the one in `main`, in the same order,
 * with the same anneal: kT interpolates linearly from kT to kT_final across the WHOLE run,
 * so the module must be told the total step budget up front. Get that wrong and every
 * block of steps re-anneals from the start, which produces a trajectory that looks fine
 * and never cools.
 *
 * Build: tools/build_wasm.sh module
 */

#define main go_model_fold_cli_main_unused
#include "go_model_fold.c"
#undef main

#include <emscripten/emscripten.h>

#define EXPORT EMSCRIPTEN_KEEPALIVE

/* One fold in progress. A worker runs exactly one, so a single static is honest here and
 * makes the JS side's job (init, step, read, free) impossible to get wrong. */
static struct {
    Model *m;
    V3 *x, *v, *f;
    int n;
    double kT, kT_final, dt, gamma;
    long step;          /* steps taken so far */
    long total;         /* the budget the anneal is measured against */
    float *positions;   /* 3n floats, refilled by bf_positions() */
    double *forcebuf;   /* 3n doubles, refilled by bf_forces() */
    int running;
} S;

/* Release everything. Safe to call twice, and called by bf_init so a worker that folds a
 * second protein does not leak the first. */
void EXPORT bf_free(void) {
    if (S.m) {
        free(S.m->r0); free(S.m->theta0); free(S.m->phi0);
        free(S.m->nat_i); free(S.m->nat_j); free(S.m->nat_sigma);
        free(S.m->non_i); free(S.m->non_j);
        free(S.m);
    }
    free(S.x); free(S.v); free(S.f); free(S.positions); free(S.forcebuf);
    memset(&S, 0, sizeof(S));
}

/* Begin a fold.
 *
 * `native` and `start` are 3n doubles each, laid out xyzxyz..., written into the module's
 * heap by the JS side. They are the same numbers the CLI would have read out of the two
 * .xyz files, which is what makes the two paths comparable.
 *
 * Returns the number of residues, or 0 if the arguments are unusable. */
int EXPORT bf_init(const double *native, const double *start, int n,
                   double kT, double kT_final, double dt, double gamma,
                   double cutoff, int min_sep, double seed_as_double, double total_steps) {
    bf_free();
    if (n < 4 || !native || !start) return 0;

    V3 *x0 = malloc(sizeof(V3) * n);
    S.x = malloc(sizeof(V3) * n);
    if (!x0 || !S.x) { free(x0); bf_free(); return 0; }
    for (int i = 0; i < n; i++) {
        x0[i] = (V3){native[3*i], native[3*i+1], native[3*i+2]};
        S.x[i] = (V3){start[3*i], start[3*i+1], start[3*i+2]};
    }

    /* Seed exactly as the CLI does, including the sixteen warm-up draws. A seed arrives as
     * a double because that is what crosses the JS boundary without a BigInt dance; it is
     * an integer in practice and is cast back to the CLI's uint64_t here. */
    rng_state = (uint64_t)seed_as_double * 6364136223846793005ULL + 1442695040888963407ULL;
    for (int i = 0; i < 16; i++) u01();

    S.m = model_build(x0, n, cutoff, min_sep);
    free(x0);
    S.n = n;
    S.kT = kT;
    S.kT_final = kT_final < 0 ? kT : kT_final;
    S.dt = dt;
    S.gamma = gamma;
    S.step = 0;
    S.total = (long)total_steps > 0 ? (long)total_steps : 1;
    S.v = calloc(n, sizeof(V3));
    S.f = malloc(sizeof(V3) * n);
    S.positions = malloc(sizeof(float) * 3 * n);
    S.forcebuf = malloc(sizeof(double) * 3 * n);
    if (!S.m || !S.v || !S.f || !S.positions || !S.forcebuf) { bf_free(); return 0; }

    for (int i = 0; i < n; i++)
        S.v[i] = (V3){gauss() * sqrt(kT), gauss() * sqrt(kT), gauss() * sqrt(kT)};
    forces(S.m, S.x, S.f);
    S.running = 1;
    return n;
}

/* Advance the fold by `steps` integration steps. Returns the total taken so far, which the
 * worker turns into a progress fraction against the budget it passed to bf_init. */
double EXPORT bf_step(double steps_as_double) {
    if (!S.running) return 0;
    long steps = (long)steps_as_double;
    double a = exp(-S.gamma * S.dt);
    for (long k = 0; k < steps && S.step < S.total; k++, S.step++) {
        double kTs = S.kT + (S.kT_final - S.kT) * ((double)S.step / (double)S.total);
        double b = sqrt(kTs * (1.0 - a * a));
        for (int i = 0; i < S.n; i++) S.v[i] = v_add(S.v[i], v_scale(S.f[i], 0.5 * S.dt));
        for (int i = 0; i < S.n; i++) S.x[i] = v_add(S.x[i], v_scale(S.v[i], 0.5 * S.dt));
        for (int i = 0; i < S.n; i++)
            S.v[i] = (V3){a * S.v[i].x + b * gauss(), a * S.v[i].y + b * gauss(),
                          a * S.v[i].z + b * gauss()};
        for (int i = 0; i < S.n; i++) S.x[i] = v_add(S.x[i], v_scale(S.v[i], 0.5 * S.dt));
        forces(S.m, S.x, S.f);
        for (int i = 0; i < S.n; i++) S.v[i] = v_add(S.v[i], v_scale(S.f[i], 0.5 * S.dt));
    }
    return (double)S.step;
}

/* A pointer into the module heap holding 3n float32, refilled on each call. float32, not
 * double: it is what the CLI writes to its frame file, what the wire format carries, and
 * what a renderer consumes, so a frame taken here is a frame taken there. */
float * EXPORT bf_positions(void) {
    if (!S.running) return 0;
    for (int i = 0; i < S.n; i++) {
        S.positions[3*i]   = (float)S.x[i].x;
        S.positions[3*i+1] = (float)S.x[i].y;
        S.positions[3*i+2] = (float)S.x[i].z;
    }
    return S.positions;
}

/* Forces on the current configuration, 3n float64. For the P0-3 parity test, which holds
 * this build to 1e-9 against the native one, so it must not be float32. */
double * EXPORT bf_forces(void) {
    if (!S.running) return 0;
    forces(S.m, S.x, S.f);
    for (int i = 0; i < S.n; i++) {
        S.forcebuf[3*i]   = S.f[i].x;
        S.forcebuf[3*i+1] = S.f[i].y;
        S.forcebuf[3*i+2] = S.f[i].z;
    }
    return S.forcebuf;
}

int EXPORT bf_residue_count(void) { return S.running ? S.n : 0; }

/* The same 1.2-sigma tolerance the CLI reports Q with, so the readout in the browser and
 * the number in METRICS.md mean the same thing. */
double EXPORT bf_native_fraction(void) {
    return S.running ? fraction_native(S.m, S.x, 1.2) : 0.0;
}

double EXPORT bf_radius_of_gyration(void) {
    if (!S.running) return 0.0;
    V3 c = {0, 0, 0};
    for (int i = 0; i < S.n; i++) c = v_add(c, S.x[i]);
    c = v_scale(c, 1.0 / S.n);
    double sum = 0;
    for (int i = 0; i < S.n; i++) {
        V3 d = v_sub(S.x[i], c);
        sum += v_dot(d, d);
    }
    return sqrt(sum / S.n);
}

/* The total step budget this fold was started with, so the worker never has to remember it
 * twice and the two copies never drift. */
double EXPORT bf_total_steps(void) { return (double)S.total; }

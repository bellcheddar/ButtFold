/* ============================================================================
 * VENDORED FILE - provenance
 *
 *   source repo:   https://github.com/bellcheddar/PhoneFold
 *   source path:   Tools/go_model_fold.c
 *   commit SHA:    6f44c8a1ac7684da93668a580b29cbe9a67cfc5e
 *   vendored on:   2026-09-01
 *
 * Copied into ButtFold verbatim. The physics in this file is NOT edited: the
 * WASM build adds native/wasm_api.c alongside it, which is additive only.
 * If PhoneFold's copy changes, re-vendor rather than patch, and update the SHA
 * above. See PLAN.md section 5.4.
 * ==========================================================================*/

/* A C-alpha structure-based (Go) model in plain C: the same potential as go_model_fold.py.
 *
 * Two reasons this exists rather than only the Python:
 *
 *   1. Speed. The numpy version costs ~370 us per integration step at 76 residues, so a
 *      folding run of ten million steps would take an hour. The physics is a few thousand
 *      pair interactions; that is a microsecond of work, and the cost is interpreter and
 *      allocation overhead.
 *   2. It is the honest proxy for the on-device budget. PhoneFold's engine would be Swift
 *      doing exactly this arithmetic, so single-core scalar C on this Mac is the closest
 *      measurable stand-in for what an iPhone would run. clang compiles both.
 *
 * Correctness is not asserted here: `--forces` prints the force array for a given
 * configuration and go_model_selftest.py compares it against the numpy implementation,
 * which is itself checked against finite differences of its own energy.
 *
 * Build:  clang -O2 -o go_model_fold go_model_fold.c -lm
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct { double x, y, z; } V3;

static V3 v_sub(V3 a, V3 b) { return (V3){a.x - b.x, a.y - b.y, a.z - b.z}; }
static V3 v_add(V3 a, V3 b) { return (V3){a.x + b.x, a.y + b.y, a.z + b.z}; }
static V3 v_scale(V3 a, double s) { return (V3){a.x * s, a.y * s, a.z * s}; }
static double v_dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static V3 v_cross(V3 a, V3 b) {
    return (V3){a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
static double v_len(V3 a) { return sqrt(v_dot(a, a)); }

/* ---------------------------------------------------------------- model ------------- */

typedef struct {
    int n;
    double kr, kt, kd, eps, sigma_nn;
    double *r0;       /* n-1 */
    double *theta0;   /* n-2 */
    double *phi0;     /* n-3 */
    int    *nat_i, *nat_j;  double *nat_sigma;  int n_nat;
    int    *non_i, *non_j;                      int n_non;
} Model;

static double bond_angle(const V3 *x, int a, int b, int c) {
    V3 u = v_sub(x[a], x[b]), v = v_sub(x[c], x[b]);
    double cs = v_dot(u, v) / (v_len(u) * v_len(v));
    if (cs > 1) cs = 1; if (cs < -1) cs = -1;
    return acos(cs);
}

static double dihedral(const V3 *x, int a, int b, int c, int d) {
    V3 b1 = v_sub(x[b], x[a]), b2 = v_sub(x[c], x[b]), b3 = v_sub(x[d], x[c]);
    V3 n1 = v_cross(b1, b2), n2 = v_cross(b2, b3);
    V3 m = v_cross(n1, v_scale(b2, 1.0 / v_len(b2)));
    return atan2(v_dot(m, n2), v_dot(n1, n2));
}

static Model *model_build(const V3 *x0, int n, double cutoff, int min_sep) {
    Model *m = calloc(1, sizeof(Model));
    m->n = n; m->kr = 100.0; m->kt = 20.0; m->kd = 1.0; m->eps = 1.0; m->sigma_nn = 4.0;
    m->r0 = malloc(sizeof(double) * (n - 1));
    for (int i = 0; i < n - 1; i++) m->r0[i] = v_len(v_sub(x0[i + 1], x0[i]));
    m->theta0 = malloc(sizeof(double) * (n - 2));
    for (int i = 0; i < n - 2; i++) m->theta0[i] = bond_angle(x0, i, i + 1, i + 2);
    m->phi0 = malloc(sizeof(double) * (n - 3));
    for (int i = 0; i < n - 3; i++) m->phi0[i] = dihedral(x0, i, i + 1, i + 2, i + 3);

    int cap = n * n / 2 + 8;
    m->nat_i = malloc(sizeof(int) * cap); m->nat_j = malloc(sizeof(int) * cap);
    m->nat_sigma = malloc(sizeof(double) * cap);
    m->non_i = malloc(sizeof(int) * cap); m->non_j = malloc(sizeof(int) * cap);
    for (int i = 0; i < n; i++)
        for (int j = i + min_sep; j < n; j++) {
            double d = v_len(v_sub(x0[j], x0[i]));
            if (d < cutoff) {
                m->nat_i[m->n_nat] = i; m->nat_j[m->n_nat] = j;
                m->nat_sigma[m->n_nat++] = d;
            } else {
                m->non_i[m->n_non] = i; m->non_j[m->n_non++] = j;
            }
        }
    return m;
}

static void forces(const Model *m, const V3 *x, V3 *f) {
    int n = m->n;
    memset(f, 0, sizeof(V3) * n);

    for (int i = 0; i < n - 1; i++) {                       /* bonds */
        V3 d = v_sub(x[i + 1], x[i]);
        double r = v_len(d), c = 2.0 * m->kr * (r - m->r0[i]) / r;
        f[i] = v_add(f[i], v_scale(d, c));
        f[i + 1] = v_add(f[i + 1], v_scale(d, -c));
    }

    for (int i = 0; i < n - 2; i++) {                       /* angles */
        int a = i, b = i + 1, c = i + 2;
        V3 u = v_sub(x[a], x[b]), v = v_sub(x[c], x[b]);
        double lu = v_len(u), lv = v_len(v);
        double cs = v_dot(u, v) / (lu * lv);
        if (cs > 1) cs = 1; if (cs < -1) cs = -1;
        double th = acos(cs), sn = sqrt(fmax(1 - cs * cs, 1e-12));
        double dE = 2.0 * m->kt * (th - m->theta0[i]);
        V3 dca = v_sub(v_scale(v, 1.0 / (lu * lv)), v_scale(u, cs / (lu * lu)));
        V3 dcc = v_sub(v_scale(u, 1.0 / (lu * lv)), v_scale(v, cs / (lv * lv)));
        double k = -dE / sn;
        V3 fa = v_scale(dca, -k), fc = v_scale(dcc, -k);
        f[a] = v_add(f[a], fa);
        f[c] = v_add(f[c], fc);
        f[b] = v_sub(f[b], v_add(fa, fc));
    }

    for (int i = 0; i < n - 3; i++) {                       /* dihedrals */
        int a = i, b = i + 1, c = i + 2, d = i + 3;
        V3 b1 = v_sub(x[b], x[a]), b2 = v_sub(x[c], x[b]), b3 = v_sub(x[d], x[c]);
        V3 n1 = v_cross(b1, b2), n2 = v_cross(b2, b3);
        double n1sq = v_dot(n1, n1), n2sq = v_dot(n2, n2), lb2 = v_len(b2);
        V3 mm = v_cross(n1, v_scale(b2, 1.0 / lb2));
        double phi = atan2(v_dot(mm, n2), v_dot(n1, n2));
        double dp = phi - m->phi0[i];
        double dE = m->kd * (sin(dp) + 1.5 * sin(3.0 * dp));
        V3 da = v_scale(n1, lb2 / n1sq);
        V3 dd = v_scale(n2, -lb2 / n2sq);
        double p = v_dot(b1, b2) / (lb2 * lb2), q = v_dot(b3, b2) / (lb2 * lb2);
        V3 db = v_add(v_scale(da, -1 - p), v_scale(dd, q));
        V3 dc = v_add(v_scale(da, p), v_scale(dd, -1 - q));
        double k = -dE;
        f[a] = v_add(f[a], v_scale(da, k));
        f[b] = v_add(f[b], v_scale(db, k));
        f[c] = v_add(f[c], v_scale(dc, k));
        f[d] = v_add(f[d], v_scale(dd, k));
    }

    for (int p = 0; p < m->n_nat; p++) {                    /* native 10-12 */
        int i = m->nat_i[p], j = m->nat_j[p];
        V3 dv = v_sub(x[j], x[i]);
        double r2 = v_dot(dv, dv), s2 = m->nat_sigma[p] * m->nat_sigma[p] / r2;
        double s10 = s2 * s2 * s2 * s2 * s2, s12 = s10 * s2;
        double dEdr_over_r = m->eps * 60.0 * (s10 - s12) / r2;
        V3 g = v_scale(dv, -dEdr_over_r);
        f[i] = v_sub(f[i], g);
        f[j] = v_add(f[j], g);
    }

    for (int p = 0; p < m->n_non; p++) {                    /* non-native repulsion */
        int i = m->non_i[p], j = m->non_j[p];
        V3 dv = v_sub(x[j], x[i]);
        double r2 = v_dot(dv, dv), s2 = m->sigma_nn * m->sigma_nn / r2;
        double s12 = s2 * s2 * s2 * s2 * s2 * s2;
        double dEdr_over_r = -12.0 * m->eps * s12 / r2;
        V3 g = v_scale(dv, -dEdr_over_r);
        f[i] = v_sub(f[i], g);
        f[j] = v_add(f[j], g);
    }
}

static double fraction_native(const Model *m, const V3 *x, double tol) {
    int c = 0;
    for (int p = 0; p < m->n_nat; p++)
        if (v_len(v_sub(x[m->nat_j[p]], x[m->nat_i[p]])) < tol * m->nat_sigma[p]) c++;
    return m->n_nat ? (double)c / m->n_nat : 0.0;
}

/* -------------------------------------------------------------- rng ----------------- */

static uint64_t rng_state = 0x853c49e6748fea9bULL;
static double u01(void) {
    rng_state ^= rng_state << 13; rng_state ^= rng_state >> 7; rng_state ^= rng_state << 17;
    return ((rng_state >> 11) + 1.0) * (1.0 / 9007199254740994.0);
}
static double gauss(void) {
    double u = u01(), v = u01();
    return sqrt(-2.0 * log(u)) * cos(6.283185307179586 * v);
}

/* -------------------------------------------------------------- main ---------------- */

static int read_xyz(const char *path, V3 **out) {
    FILE *fp = fopen(path, "r");
    if (!fp) { perror(path); exit(1); }
    int cap = 64, n = 0;
    V3 *x = malloc(sizeof(V3) * cap);
    while (fscanf(fp, "%lf %lf %lf", &x[n].x, &x[n].y, &x[n].z) == 3) {
        if (++n == cap) { cap *= 2; x = realloc(x, sizeof(V3) * cap); }
    }
    fclose(fp);
    *out = x;
    return n;
}

int main(int argc, char **argv) {
    const char *native_path = NULL, *start_path = NULL, *out_path = NULL;
    long steps = 1000000, stride = 2000;
    double kT = 1.0, kT_final = -1.0, dt = 0.005, gamma = 1.0, cutoff = 8.0;
    int min_sep = 3, forces_only = 0, bench = 0;
    uint64_t seed = 1;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--native")) native_path = argv[++i];
        else if (!strcmp(argv[i], "--start")) start_path = argv[++i];
        else if (!strcmp(argv[i], "--out")) out_path = argv[++i];
        else if (!strcmp(argv[i], "--steps")) steps = atol(argv[++i]);
        else if (!strcmp(argv[i], "--stride")) stride = atol(argv[++i]);
        else if (!strcmp(argv[i], "--kT")) kT = atof(argv[++i]);
        else if (!strcmp(argv[i], "--kT-final")) kT_final = atof(argv[++i]);
        else if (!strcmp(argv[i], "--dt")) dt = atof(argv[++i]);
        else if (!strcmp(argv[i], "--gamma")) gamma = atof(argv[++i]);
        else if (!strcmp(argv[i], "--cutoff")) cutoff = atof(argv[++i]);
        else if (!strcmp(argv[i], "--min-sep")) min_sep = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--seed")) seed = strtoull(argv[++i], NULL, 10);
        else if (!strcmp(argv[i], "--forces")) forces_only = 1;
        else if (!strcmp(argv[i], "--bench")) bench = 1;
        else { fprintf(stderr, "unknown argument %s\n", argv[i]); return 2; }
    }
    if (!native_path || !start_path) {
        fprintf(stderr, "usage: %s --native ref.xyz --start start.xyz [--out frames.bin] "
                        "[--steps N] [--stride N] [--kT t] [--kT-final t] [--dt d] [--gamma g] "
                        "[--seed s] [--forces] [--bench]\n", argv[0]);
        return 2;
    }
    rng_state = seed * 6364136223846793005ULL + 1442695040888963407ULL;
    for (int i = 0; i < 16; i++) u01();

    V3 *x0, *x;
    int n = read_xyz(native_path, &x0);
    int n2 = read_xyz(start_path, &x);
    if (n != n2) { fprintf(stderr, "native has %d residues, start has %d\n", n, n2); return 2; }
    Model *m = model_build(x0, n, cutoff, min_sep);
    V3 *f = malloc(sizeof(V3) * n), *v = calloc(n, sizeof(V3));

    if (forces_only) {
        forces(m, x, f);
        for (int i = 0; i < n; i++) printf("%.12e %.12e %.12e\n", f[i].x, f[i].y, f[i].z);
        return 0;
    }

    if (bench) {
        forces(m, x, f);
        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);
        for (long s = 0; s < steps; s++) forces(m, x, f);
        clock_gettime(CLOCK_MONOTONIC, &t1);
        double sec = (t1.tv_sec - t0.tv_sec) + 1e-9 * (t1.tv_nsec - t0.tv_nsec);
        printf("residues %d  native %d  nonnative %d  force evals %ld  %.3f s  "
               "%.3f us/eval  %.0f evals/s\n",
               n, m->n_nat, m->n_non, steps, sec, 1e6 * sec / steps, steps / sec);
        return 0;
    }

    FILE *out = NULL;
    if (out_path) {
        out = fopen(out_path, "wb");
        int32_t hdr[2] = {n, (int32_t)(steps / stride + 1)};
        fwrite(hdr, sizeof(int32_t), 2, out);
    }
    float *buf = malloc(sizeof(float) * 3 * n);
    #define EMIT() do { if (out) { for (int i = 0; i < n; i++) { \
        buf[3*i] = (float)x[i].x; buf[3*i+1] = (float)x[i].y; buf[3*i+2] = (float)x[i].z; } \
        fwrite(buf, sizeof(float), 3 * n, out); } } while (0)

    for (int i = 0; i < n; i++)
        v[i] = (V3){gauss() * sqrt(kT), gauss() * sqrt(kT), gauss() * sqrt(kT)};
    forces(m, x, f);
    EMIT();

    /* Optional linear anneal. A single temperature near Tf gives a real two-state
     * transition but also real reversals and real kinetic traps: measured on villin, the
     * chain reached Q = 1.0 and had fallen back to 0.77 by the end of the run. Cooling
     * across the run keeps the physics and removes the coin flip. */
    double a = exp(-gamma * dt);
    if (kT_final < 0) kT_final = kT;
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (long s = 0; s < steps; s++) {
        double kTs = kT + (kT_final - kT) * ((double)s / (double)steps);
        double b = sqrt(kTs * (1.0 - a * a));
        for (int i = 0; i < n; i++) v[i] = v_add(v[i], v_scale(f[i], 0.5 * dt));
        for (int i = 0; i < n; i++) x[i] = v_add(x[i], v_scale(v[i], 0.5 * dt));
        for (int i = 0; i < n; i++)
            v[i] = (V3){a * v[i].x + b * gauss(), a * v[i].y + b * gauss(),
                        a * v[i].z + b * gauss()};
        for (int i = 0; i < n; i++) x[i] = v_add(x[i], v_scale(v[i], 0.5 * dt));
        forces(m, x, f);
        for (int i = 0; i < n; i++) v[i] = v_add(v[i], v_scale(f[i], 0.5 * dt));
        if ((s + 1) % stride == 0) EMIT();
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double sec = (t1.tv_sec - t0.tv_sec) + 1e-9 * (t1.tv_nsec - t0.tv_nsec);
    fprintf(stderr, "%ld steps in %.3f s (%.3f us/step, %.0f steps/s), Q final %.3f\n",
            steps, sec, 1e6 * sec / steps, steps / sec, fraction_native(m, x, 1.2));
    if (out) fclose(out);
    return 0;
}

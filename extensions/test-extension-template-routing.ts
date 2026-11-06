// Source text of the routing block embedded in the generated
// `.pi/extensions/test.ts` (a plain-JS port of suite-scope.ts routeSuites:
// language match, deepest-ancestor cwd, D paths dropped, placeholder
// rewriting). The text must stay byte-identical across refactors: any change
// regenerates the file in every user repo.

/**
 * Render the generated extension's routing block.
 *
 * Emits plain JS-compatible source for the per-suite routing decision —
 * effectiveScope, suiteLang/pathLang matching, deepest-ancestor cwd,
 * D-status dropping, files/packages argv rewriting — plus the -run
 * insertion for the structured `run` filter. The block ends with a blank
 * line so the tool registration follows directly.
 *
 * @returns The routing block source text.
 */
export function generatedRoutingSource(): string {
  return `const JS_EXT = /\\.(ts|tsx|js|jsx)$/;

/** Repo-relative POSIX-style normalize for routing inputs (no imports). */
function normPath(p) {
  const absolute = p.charAt(0) === "/";
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join("/");
  if (absolute) return "/" + joined;
  return joined === "" ? "." : joined;
}

/** posix.relative(from, to) for normalized repo-relative inputs. */
function relPath(from, to) {
  const f = from === "." ? [] : from.split("/");
  const t = to.split("/");
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  const parts = [];
  for (let k = 0; k < f.length - i; k++) parts.push("..");
  for (let k = i; k < t.length; k++) parts.push(t[k]);
  return parts.join("/");
}

/** Routing scope of a suite: explicit, else packages for go test, else full. */
function effectiveScope(suite) {
  if (suite.scope) return suite.scope;
  return suite.argv[0] === "go" && suite.argv[1] === "test" ? "packages" : "full";
}

/** Language a suite runs (python/js/go), or null when it never routes. */
function suiteLang(suite) {
  const a = suite.argv;
  if (a.some((p) => p === "pytest" || p.endsWith("/pytest"))) return "python";
  if (a.some((p) => p === "vitest" || p === "jest")) return "js";
  if (a[0] === "go") return "go";
  return null;
}

/** Language of a routed path (py/go/js extension), or null. */
function pathLang(path) {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".go")) return "go";
  if (JS_EXT.test(path)) return "js";
  return null;
}

/** Normalized suite cwd ("." default, no trailing slash). */
function normCwd(cwd) {
  const n = normPath(cwd || ".").replace(/\\/+$/, "");
  return n === "" ? "." : n;
}

/** True when cwd is "." or an ancestor of path. */
function contains(cwd, path) {
  return cwd === "." || path === cwd || path.startsWith(cwd + "/");
}

/** Cwd depth for the deepest-ancestor tie-break ("." = 0). */
function depth(cwd) {
  return cwd === "." ? 0 : cwd.split("/").length;
}

/** Drop the {tests}/{pkgs} placeholders (full-suite argv). */
function stripPlaceholders(argv) {
  return argv.filter((p) => p !== "{tests}" && p !== "{pkgs}");
}

/** Files-suite argv: insert routed rel paths at {tests} (append when absent). */
function filesArgv(argv, files) {
  const i = argv.indexOf("{tests}");
  if (i < 0) return argv.concat(files);
  return argv.slice(0, i).concat(files, argv.slice(i + 1));
}

/** Packages-suite argv: replace {pkgs} (or ./...) with routed ./<dir>/... . */
function pkgsArgv(argv, pkgs) {
  let i = argv.indexOf("{pkgs}");
  if (i < 0) i = argv.indexOf("./...");
  if (i < 0) return stripPlaceholders(argv.concat(pkgs));
  return stripPlaceholders(argv.slice(0, i).concat(pkgs, argv.slice(i + 1)));
}

/**
 * Route paths to suites and build each suite's argv: a path goes only to the
 * matching-language suite whose cwd is the deepest ancestor, D paths are
 * dropped, files/packages suites with no routed paths are skipped and full
 * suites always run with placeholders removed (port of suite-scope.ts).
 *
 * @param suites - Suites in order (label + argv + scope + cwd).
 * @param paths  - Candidate paths with contract status.
 * @returns One run per suite, in input order.
 */
function routeSuites(suites, paths) {
  const routed = new Map();
  for (const entry of paths) {
    if (entry.status === "D") continue;
    const p = normPath(entry.path);
    const lang = pathLang(p);
    if (!lang) continue;
    let best = -1;
    suites.forEach((s, idx) => {
      if (effectiveScope(s) === "full" || suiteLang(s) !== lang) return;
      const cwd = normCwd(s.cwd);
      if (!contains(cwd, p)) return;
      if (best < 0 || depth(cwd) > depth(normCwd(suites[best].cwd))) best = idx;
    });
    if (best < 0) continue;
    if (lang === "go" && !p.endsWith("_test.go")) continue;
    routed.set(best, (routed.get(best) || []).concat([p]));
  }
  return suites.map((suite, idx) => {
    const scope = effectiveScope(suite);
    if (scope === "full") return { suite: suite, skipped: false, argv: stripPlaceholders(suite.argv) };
    const list = routed.get(idx) || [];
    if (list.length === 0) return { suite: suite, skipped: true, argv: [] };
    const cwd = normCwd(suite.cwd);
    const rel = list.map((p) => (cwd === "." ? p : relPath(cwd, p)));
    if (scope === "files") return { suite: suite, skipped: false, argv: filesArgv(suite.argv, rel) };
    const dirs = [];
    for (const r of rel) {
      const d = r.lastIndexOf("/") < 0 ? "." : r.slice(0, r.lastIndexOf("/"));
      if (dirs.indexOf(d) < 0) dirs.push(d);
    }
    const pkgs = dirs.map((d) => (d === "." ? "./..." : "./" + d + "/..."));
    return { suite: suite, skipped: false, argv: pkgsArgv(suite.argv, pkgs) };
  });
}

/** Insert -run into a routed go test argv (structured run filter, T7). */
function withRun(argv, run) {
  if (!run || argv[0] !== "go" || argv[1] !== "test") return argv;
  return [argv[0], argv[1], "-run", run].concat(argv.slice(2));
}

`;
}

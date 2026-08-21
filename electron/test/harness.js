// Opens a throwaway data file and calls the operations directly, the same way
// the main process does. No window and no Electron, so the checks can run
// anywhere - including in a build pipeline.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, reseed } from "../src/database.js";
import { dispatch, AppError } from "../src/core.js";

export function freshApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ut-test-"));
  const assets = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "static");
  const db = open(path.join(dir, "test.db"), assets);
  const user = db.get("SELECT * FROM users WHERE username = 'admin'");

  const ctx = {
    db,
    user,
    loginRequired: () => false,
    requireUser: () => { if (!ctx.user) throw new AppError(401, "Please sign in."); },
    requireAdmin: () => {
      ctx.requireUser();
      if (ctx.user.role !== "admin") throw new AppError(403, "Administrator only.");
    },
    signIn: (u) => { ctx.user = u; },
    signOut: () => { ctx.user = null; },
    refreshUser: () => { ctx.user = db.get("SELECT * FROM users WHERE id = ?", [ctx.user.id]); },
    reseed: () => reseed(db, assets),
  };

  return {
    dir,
    db,
    call: (method, apiPath, body, query) => dispatch(ctx, method, apiPath, body, query),
    /** Runs an operation that is expected to fail, and returns the error. */
    failing: (method, apiPath, body, query) => {
      try {
        dispatch(ctx, method, apiPath, body, query);
        return null;
      } catch (err) {
        return err;
      }
    },
    cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

export function reporter(title) {
  const failures = [];
  console.log(`\n=== ${title} ===`);
  return {
    expect(label, actual, wanted) {
      const ok = Math.abs(Number(actual) - Number(wanted)) < 0.01;
      const shown = Number(actual).toLocaleString("en-US", { minimumFractionDigits: 2 });
      const want = Number(wanted).toLocaleString("en-US", { minimumFractionDigits: 2 });
      console.log(`  ${ok ? "PASS " : "FAIL "} ${label.padEnd(42)} app ${shown.padStart(13)}` +
        `   by hand ${want.padStart(13)}`);
      if (!ok) failures.push(label);
    },
    check(label, ok, detail = "") {
      console.log(`  ${ok ? "PASS " : "FAIL "} ${label}${ok ? "" : `   <- ${detail}`}`);
      if (!ok) failures.push(`${label} ${detail}`);
    },
    section(name) { console.log(`\n--- ${name} ---`); },
    finish() {
      console.log("\n" + "=".repeat(76));
      if (failures.length) {
        console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
        process.exit(1);
      }
      console.log(`ALL CHECKS PASSED (${title})`);
    },
    failures,
  };
}

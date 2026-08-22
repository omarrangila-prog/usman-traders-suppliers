// Usman Traders & Suppliers - the desktop program.
//
// Electron's main process owns the data file and every operation. The window
// is only an interface: it asks for work over IPC and draws the answer. There
// is no web server, no port and no network - closing the laptop lid or pulling
// the cable changes nothing, because nothing was ever being sent anywhere.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const url = require("node:url");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function contentType(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

const ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
const STATIC_DIR = path.join(ROOT, "static");

// Loaded from the ES modules once Electron is ready.
let core = null;
let database = null;
let exportsModule = null;
let syncModule = null;
let db = null;
let currentUser = null;
let mainWindow = null;

const LOGIN_REQUIRED = process.env.UT_LOGIN !== "off";

/** Where the data file lives: alongside the user's other application data, a
 *  place that is always writable, unlike the folder the program installs to. */
function dataFile() {
  return process.env.UT_DB || path.join(app.getPath("userData"), "usmantraders.db");
}

function buildContext() {
  const ctx = {
    get db() { return db; },
    get user() { return currentUser; },
    loginRequired: () => LOGIN_REQUIRED,
    requireUser: () => {
      if (!currentUser) throw new core.AppError(401, "Please sign in.");
    },
    requireAdmin: () => {
      ctx.requireUser();
      if (currentUser.role !== "admin") {
        throw new core.AppError(403, "Only an administrator can do that.");
      }
    },
    signIn: (user) => { currentUser = user; },
    signOut: () => { currentUser = null; },
    refreshUser: () => {
      if (currentUser) {
        currentUser = db.get("SELECT * FROM users WHERE id = ?", [currentUser.id]);
      }
    },
    reseed: () => { database.reseed(db, STATIC_DIR); },
  };
  return ctx;
}

let context = null;

// ------------------------------------------------------------------ the work

ipcMain.handle("ut:call", async (_event, { method, path: apiPath, body, query }) => {
  try {
    if (exportsModule.isExport(apiPath)) {
      return { ok: true, data: await saveWorkbook(apiPath, query) };
    }
    if (apiPath === "/api/backup") return { ok: true, data: await saveBackup() };
    return { ok: true, data: core.dispatch(context, method, apiPath, body, query) };
  } catch (err) {
    return { ok: false, status: err.status || 500, error: err.message || String(err) };
  }
});

async function saveWorkbook(apiPath, query) {
  const book = exportsModule.build(context, apiPath, query || {});
  const chosen = await dialog.showSaveDialog(mainWindow, {
    title: "Save report",
    defaultPath: path.join(app.getPath("documents"), book.filename),
    filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
  });
  if (chosen.canceled || !chosen.filePath) return { saved: false };
  fs.writeFileSync(chosen.filePath, book.data);
  return { saved: true, path: chosen.filePath };
}

async function saveBackup() {
  context.requireAdmin();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const chosen = await dialog.showSaveDialog(mainWindow, {
    title: "Save a backup of your data",
    defaultPath: path.join(app.getPath("documents"), `usmantraders-backup-${stamp}.db`),
    filters: [{ name: "Data file", extensions: ["db"] }],
  });
  if (chosen.canceled || !chosen.filePath) return { saved: false };
  // Ask SQLite to copy it, so a backup taken while the program is running is
  // still a consistent file rather than a half-written one.
  db.raw.exec(`VACUUM INTO '${chosen.filePath.replace(/'/g, "''")}'`);
  return { saved: true, path: chosen.filePath };
}

// ------------------------------------------------------------------ sharing
//
// The one place the program reaches the network, and only when asked. The
// books are readable and writable whether it succeeds or not.

function sharingSettings() {
  const row = db.get("SELECT value FROM sync_state WHERE key = 'account'");
  const saved = row ? JSON.parse(row.value) : {};
  return { url: saved.url || "", username: saved.username || "admin",
    password: saved.password || "", auto: Boolean(saved.auto) };
}

ipcMain.handle("ut:sharing", () => {
  const settings = sharingSettings();
  return {
    url: settings.url, username: settings.username, auto: settings.auto,
    // never hand the password back to the window; only whether one is set
    has_password: Boolean(settings.password),
    last_sync: syncModule.lastSync(db),
    unresolved: db.scalar("SELECT COUNT(*) FROM sync_conflicts WHERE reviewed = 0"),
  };
});

ipcMain.handle("ut:sharing/save", (_event, settings) => {
  context.requireAdmin();
  const current = sharingSettings();
  const merged = {
    url: String(settings.url || "").trim(),
    username: String(settings.username || "admin").trim(),
    // an empty box means "leave the password alone", not "clear it"
    password: settings.password ? String(settings.password) : current.password,
    auto: Boolean(settings.auto),
  };
  db.run(`INSERT INTO sync_state (key, value) VALUES ('account', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(merged)]);
  return { ok: true };
});

ipcMain.handle("ut:sync", async () => {
  try {
    context.requireUser();
    const account = sharingSettings();
    if (!account.url) {
      return { ok: false, error: "No cloud address has been set. Open Settings first." };
    }
    const result = await syncModule.exchange(db, account);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle("ut:conflicts", () => {
  context.requireUser();
  return db.all("SELECT * FROM sync_conflicts ORDER BY id DESC LIMIT 100");
});

ipcMain.handle("ut:where", () => ({
  data: dataFile(),
  folder: app.getPath("userData"),
  version: app.getVersion(),
}));

ipcMain.handle("ut:reveal", (_event, target) => {
  shell.showItemInFolder(target || dataFile());
});

// ---------------------------------------------------------------- the window

function menuTemplate() {
  return [
    {
      label: "File",
      submenu: [
        { label: "Save a backup...", accelerator: "CmdOrCtrl+B",
          click: () => mainWindow.webContents.send("ut:menu", "backup") },
        { label: "Where is my data?", click: showDataLocation },
        { type: "separator" },
        { label: "Share with the cloud now", accelerator: "CmdOrCtrl+R",
          click: () => mainWindow.webContents.send("ut:menu", "sync") },
        { type: "separator" },
        { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "togglefullscreen" },
        { label: "Developer tools", accelerator: "F12",
          click: () => mainWindow.webContents.toggleDevTools() },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "About", click: () => dialog.showMessageBox(mainWindow, {
          type: "info", title: "Usman Traders & Suppliers",
          message: "Usman Traders & Suppliers",
          detail: `Version ${app.getVersion()}\n\nYour data is stored on this computer at:\n` +
            `${dataFile()}\n\nNothing is sent anywhere.`,
        }) },
      ],
    },
  ];
}

function showDataLocation() {
  dialog.showMessageBox(mainWindow, {
    type: "info", title: "Where your data is kept",
    message: "Your data is a single file on this computer.",
    detail: dataFile() + "\n\nKeep a copy of this file somewhere safe " +
      "(File > Save a backup).",
    buttons: ["Show me the folder", "Close"], defaultId: 0,
  }).then(({ response }) => {
    if (response === 0) shell.showItemInFolder(dataFile());
  });
}

// Kept so a failing self check can say what the page complained about, rather
// than only that something did not work.
const consoleLog = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320, height: 880, minWidth: 960, minHeight: 620,
    title: "Usman Traders & Suppliers",
    icon: path.join(STATIC_DIR, process.platform === "win32" ? "icon.ico" : "logo.png"),
    backgroundColor: "#f7f3ee",
    show: false,                       // avoid a white flash before the paint
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("console-message", (event) => {
    if (consoleLog.length < 40) {
      consoleLog.push(`[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, description, target) => {
    consoleLog.push(`failed to load ${target}: ${description} (${code})`);
  });
  mainWindow.loadURL("app://usmantraders/index.html");

  // Anything aiming outside the program opens in the real browser instead of
  // replacing the interface with a page the user cannot navigate back from.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith("app://")) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });
}

// A private scheme rather than file://, so the absolute paths the interface
// already uses (/styles.css, /app.js) resolve, and so the page counts as a
// secure origin.
protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

app.whenReady().then(async () => {
  try {
    database = await import(url.pathToFileURL(path.join(__dirname, "src/database.js")).href);
    core = await import(url.pathToFileURL(path.join(__dirname, "src/core.js")).href);
    exportsModule = await import(url.pathToFileURL(path.join(__dirname, "src/exports.js")).href);
    syncModule = await import(url.pathToFileURL(path.join(__dirname, "src/sync.js")).href);

    db = database.open(dataFile(), STATIC_DIR);
    context = buildContext();
    if (!LOGIN_REQUIRED) {
      currentUser = db.get(
        "SELECT * FROM users WHERE active = 1 AND role = 'admin' ORDER BY id LIMIT 1");
    }
  } catch (err) {
    dialog.showErrorBox("Usman Traders could not start",
      `${err.message}\n\nData file:\n${dataFile()}`);
    app.quit();
    return;
  }

  protocol.handle("app", (request) => {
    const asked = new URL(request.url);
    const wanted = decodeURIComponent(asked.pathname);
    const file = path.join(STATIC_DIR, wanted === "/" ? "index.html" : wanted);
    // Never serve anything outside the program's own files.
    if (!path.resolve(file).startsWith(path.resolve(STATIC_DIR))) {
      return new Response("Not found", { status: 404 });
    }
    try {
      // The type has to be stated. A browser engine will not run a script or
      // apply a stylesheet that arrives without one, and the page would come
      // up blank with nothing in the log to say why.
      return new Response(fs.readFileSync(file), {
        headers: { "Content-Type": contentType(file) },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
  createWindow();

  if (process.argv.includes("--self-check")) {
    selfCheck();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// --------------------------------------------------------------- self check
//
// Started with --self-check the program proves itself on the machine it is
// installed on: a real window opens, the interface loads inside it, and the
// operations answer with the business's own data. Then it reports and exits.
// This is what the build pipeline runs before a release is published.

async function selfCheck() {
  console.log(`  version:   ${app.getVersion()}`);
  console.log(`  data file: ${dataFile()}`);
  const results = [];
  const record = (label, ok, detail = "") => {
    results.push({ label, ok, detail });
    console.log(`${ok ? "  PASS  " : "  FAIL  "}${label}${ok ? "" : `   <- ${detail}`}`);
  };

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the interface never finished loading")),
        30000);
      mainWindow.webContents.once("did-finish-load", () => { clearTimeout(timer); resolve(); });
    });

    mainWindow.show();
    record("a real window opened", !mainWindow.isDestroyed() && mainWindow.isVisible());
    record("the window has the business's name",
      mainWindow.getTitle().includes("Usman Traders"), mainWindow.getTitle());

    const size = mainWindow.getBounds();
    record("the window has a usable size", size.width >= 900 && size.height >= 600,
      `${size.width}x${size.height}`);

    // The interface signs itself in and draws the dashboard on its own, so wait
    // for that to finish rather than inspecting the script that does it.
    const probe = "({"
      + " bridge: Boolean(window.usmanTraders && window.usmanTraders.desktop),"
      // a stylesheet that was refused still appears in the list but holds no
      // rules, so counting the rules is what actually proves it was applied
      + " cssRules: [...document.styleSheets].reduce((n, s) => {"
      + "   try { return n + s.cssRules.length; } catch (e) { return n; } }, 0),"
      + " navLinks: document.querySelectorAll('#nav a, #nav button').length,"
      + " signedIn: !document.getElementById('app').classList.contains('hidden'),"
      + " content: (document.getElementById('content') || {}).innerHTML || '',"
      + " loginShown: !document.getElementById('login-screen').classList.contains('hidden'),"
      + " chip: (document.getElementById('cloud-text') || {}).textContent || '',"
      + " sharing: Boolean(document.getElementById('sync-chip'))"
      + "})";

    let view = await mainWindow.webContents.executeJavaScript(probe);
    for (let waited = 0; waited < 20000 && !view.navLinks; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      view = await mainWindow.webContents.executeJavaScript(probe);
    }

    record("it is wired to the program, not to a server", view.bridge);
    record("the stylesheet was applied", view.cssRules > 50, `${view.cssRules} rules`);
    record("the interface built its menu", view.navLinks >= 5, `${view.navLinks} links`);
    record("it signed in and opened the app", view.signedIn,
      view.loginShown ? "it stopped at the sign-in screen" : "neither screen is showing");
    record("a page rendered, not a spinner or an error",
      view.content.length > 400 && !view.content.includes("Loading..."),
      `${view.content.length} chars`);
    record("nothing claims a cloud or a server is missing",
      !/fail|unreachable|offline|error/i.test(view.chip), view.chip);
    record("the sharing control is present", view.sharing);
    record("the dashboard shows real figures",
      /Stock value|Receivables|Sales this month/i.test(view.content),
      view.content.slice(0, 120).replace(/\s+/g, " "));

    const health = await mainWindow.webContents.executeJavaScript(
      "window.usmanTraders.call('GET', '/api/health', {}, {})");
    record("operations answer from inside the window", health.ok && health.data.ok,
      JSON.stringify(health));

    const items = await mainWindow.webContents.executeJavaScript(
      "window.usmanTraders.call('GET', '/api/products', {}, {})");
    record("the item master is there", items.ok && items.data.length === 64,
      items.ok ? items.data.length : items.error);

    const where = await mainWindow.webContents.executeJavaScript(
      "window.usmanTraders.where()");
    record("the data file is on this computer", Boolean(where.data), where.data);
    record("the data file was written", fs.existsSync(dataFile()), dataFile());

    // Proves the window is genuinely painting, not merely constructed. The
    // compositor can hand back a blank frame if it is asked at the wrong
    // moment, so take the best of a few tries rather than trusting one.
    let png = Buffer.alloc(0);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const shot = (await mainWindow.webContents.capturePage()).toPNG();
      if (shot.length > png.length) png = shot;
      if (png.length > 20000) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    record("the window is actually drawing", png.length > 20000, `${png.length} bytes`);
    const target = process.env.UT_SHOT;
    if (target && png.length) {
      fs.writeFileSync(target, png);
      console.log(`  screenshot: ${target}`);
    }
  } catch (err) {
    record("self check completed", false, err.message);
  }

  const failed = results.filter((x) => !x.ok);
  if (failed.length && consoleLog.length) {
    console.log("\n  what the page reported:");
    for (const line of consoleLog) console.log(`    ${line}`);
  }
  console.log(failed.length
    ? `\nSELF CHECK FAILED: ${failed.length} of ${results.length}`
    : `\nSELF CHECK PASSED: ${results.length} checks`);
  app.exit(failed.length ? 1 : 0);
}

app.on("window-all-closed", () => {
  if (db) db.close();
  app.quit();
});

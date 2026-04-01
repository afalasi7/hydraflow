import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";

const app = express();
const port = Number(process.env.PORT || 3000);
const distDir = path.resolve("dist");
const dataFile = process.env.HYDRAFLOW_DATA_FILE || path.resolve(".data/hydraflow-db.json");
const sessionCookieName = "hydraflow_session";
const defaultReminderSettings = {
  enabled: false,
  times: ["09:00", "13:00", "18:00"],
  permission: "default",
};

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

function createId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

async function ensureDataFile() {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });

  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, JSON.stringify({ users: [], sessions: [] }, null, 2));
  }
}

async function readDatabase() {
  await ensureDataFile();
  const raw = await fs.readFile(dataFile, "utf8");
  const parsed = JSON.parse(raw);
  return {
    users: Array.isArray(parsed.users) ? parsed.users : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
  };
}

async function writeDatabase(data) {
  await ensureDataFile();
  await fs.writeFile(dataFile, JSON.stringify(data, null, 2));
}

function sanitizeAccount(account) {
  return {
    ...account,
    password: "",
  };
}

function createProfile(name) {
  return {
    id: createId("profile"),
    name,
    createdAt: new Date().toISOString(),
    profile: null,
    entries: [],
    childLoggingPolicy: {
      guardrailsEnabled: true,
      suspiciousEntryMl: 500,
      burstLimitCount: 3,
      burstWindowMinutes: 2,
    },
    flaggedEvents: [],
  };
}

function createAccount({ name, email }) {
  const primaryProfile = createProfile(name);

  return {
    id: createId("acct"),
    name,
    email,
    password: "",
    createdAt: new Date().toISOString(),
    profiles: [primaryProfile],
    activeProfileId: primaryProfile.id,
    authProvider: "local",
    remoteUserId: null,
    reminderSettings: defaultReminderSettings,
  };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function requireSession(req, res, next) {
  const token = req.cookies[sessionCookieName];

  if (!token) {
    res.status(401).json({ error: "You are not signed in." });
    return;
  }

  readDatabase()
    .then((db) => {
      const session = db.sessions.find((item) => item.token === token);
      if (!session) {
        res.status(401).json({ error: "Your session is no longer valid." });
        return;
      }

      const user = db.users.find((item) => item.id === session.userId);
      if (!user) {
        res.status(401).json({ error: "Your session is no longer valid." });
        return;
      }

      req.db = db;
      req.sessionToken = token;
      req.user = user;
      next();
    })
    .catch((error) => {
      res.status(500).json({ error: error instanceof Error ? error.message : "Database error." });
    });
}

function setSessionCookie(res, token) {
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/session", requireSession, (req, res) => {
  res.json({ account: sanitizeAccount(req.user.account) });
});

app.post("/api/auth/signup", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!name || !email || !password) {
    res.status(400).json({ error: "Name, email, and password are required." });
    return;
  }

  const db = await readDatabase();
  if (db.users.some((user) => normalizeEmail(user.email) === email)) {
    res.status(409).json({ error: "That email is already registered." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const account = createAccount({ name, email });
  const user = {
    id: createId("user"),
    name,
    email,
    passwordHash,
    account,
    createdAt: new Date().toISOString(),
  };
  const token = createId("session");

  db.users.push(user);
  db.sessions = db.sessions.filter((session) => session.userId !== user.id);
  db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  await writeDatabase(db);

  setSessionCookie(res, token);
  res.status(201).json({ account: sanitizeAccount(account) });
});

app.post("/api/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const db = await readDatabase();
  const user = db.users.find((item) => normalizeEmail(item.email) === email);

  if (!user) {
    res.status(401).json({ error: "We could not match that email and password." });
    return;
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    res.status(401).json({ error: "We could not match that email and password." });
    return;
  }

  const token = createId("session");
  db.sessions = db.sessions.filter((session) => session.userId !== user.id);
  db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  await writeDatabase(db);

  setSessionCookie(res, token);
  res.json({ account: sanitizeAccount(user.account) });
});

app.post("/api/auth/logout", requireSession, async (req, res) => {
  const db = req.db;
  db.sessions = db.sessions.filter((session) => session.token !== req.sessionToken);
  await writeDatabase(db);
  res.clearCookie(sessionCookieName, { path: "/" });
  res.status(204).end();
});

app.put("/api/account", requireSession, async (req, res) => {
  const nextAccount = req.body?.account;

  if (!nextAccount || typeof nextAccount !== "object") {
    res.status(400).json({ error: "Account payload is required." });
    return;
  }

  const db = req.db;
  const userIndex = db.users.findIndex((user) => user.id === req.user.id);

  if (userIndex === -1) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const preserved = db.users[userIndex];
  const account = {
    ...nextAccount,
    id: preserved.account.id,
    email: preserved.email,
    name: nextAccount.name || preserved.name,
    password: "",
    authProvider: "local",
    remoteUserId: null,
    reminderSettings: nextAccount.reminderSettings || defaultReminderSettings,
  };

  db.users[userIndex] = {
    ...preserved,
    name: account.name,
    account,
  };
  await writeDatabase(db);

  res.json({ account: sanitizeAccount(account) });
});

app.use(express.static(distDir, { index: false }));

app.get("/*rest", (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, () => {
  console.log(`HydraFlow server listening on ${port}`);
});

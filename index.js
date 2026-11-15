// quest-worker: headless quest runner for Railway (no deps, Node 20+).
// Runs as the account behind DISCORD_TOKEN. Video + activity quests only;
// play/stream quests need a real desktop client and are skipped.

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_TOKEN is not set (Railway -> service -> Variables)");
  process.exit(1);
}

const POLL_MS = Number(process.env.POLL_MINUTES ?? 30) * 60_000;
const API = "https://discord.com/api/v9";

const VIDEO_SPEED = 7;        // fake seconds of progress per tick
const VIDEO_MAX_AHEAD = 10;   // server rejects timestamps further ahead than this from enroll time
const HEARTBEAT_MS = 20_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const superProps = {
  os: "Windows",
  browser: "Chrome",
  device: "",
  system_locale: "en-US",
  browser_user_agent: UA,
  browser_version: "126.0.0.0",
  os_version: "10",
  release_channel: "stable",
};
// FILL: current client_build_number - open discord.com/app, DevTools > Network, click any /api request,
// base64-decode the X-Super-Properties header, and set CLIENT_BUILD_NUMBER in Railway to that value.
if (process.env.CLIENT_BUILD_NUMBER) superProps.client_build_number = Number(process.env.CLIENT_BUILD_NUMBER);
const SUPER = Buffer.from(JSON.stringify(superProps)).toString("base64");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

class AuthError extends Error {}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: TOKEN,
      "Content-Type": "application/json",
      "User-Agent": UA,
      "X-Super-Properties": SUPER,
      "X-Discord-Locale": "en-US",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    const wait = (j.retry_after ?? 5) * 1000 + 500;
    log(`rate limited, waiting ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
    return call(method, path, body);
  }
  if (res.status === 401) throw new AuthError("token rejected (401)");

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }

  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------- quest parsing
const RUNNABLE = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ACTIVITY"];
const DESKTOP_ONLY = ["PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "ACHIEVEMENT_IN_ACTIVITY"];

function describe(q) {
  const cfg = q.config ?? {};
  const us = q.user_status ?? q.userStatus;
  const expires = cfg.expires_at ?? cfg.expiresAt;
  const enrolledAt = us?.enrolled_at ?? us?.enrolledAt;
  const completedAt = us?.completed_at ?? us?.completedAt;

  if (!enrolledAt || completedAt) return null;
  if (expires && Date.parse(expires) <= Date.now()) return null;

  const tasks =
    (cfg.task_config_v2 ?? cfg.taskConfigV2 ?? cfg.task_config ?? cfg.taskConfig)?.tasks ?? {};
  const title = cfg.messages?.quest_name ?? cfg.messages?.questName ?? q.id;

  const name = RUNNABLE.find((n) => tasks[n]);
  if (!name) {
    const d = DESKTOP_ONLY.find((n) => tasks[n]);
    log(`skip "${title}": ${d ?? "unknown task"} needs the desktop client`);
    return null;
  }
  return {
    id: q.id,
    title,
    name,
    target: tasks[name].target,
    done: us?.progress?.[name]?.value ?? 0,
    enrolledAt: Date.parse(enrolledAt),
  };
}

// ---------------------------------------------------------------- runners
async function runVideo(ctx) {
  let t = ctx.done;
  while (t < ctx.target) {
    const ceiling = (Date.now() - ctx.enrolledAt) / 1000 + VIDEO_MAX_AHEAD;
    if (t + VIDEO_SPEED <= ceiling) {
      t = Math.min(ctx.target, t + VIDEO_SPEED);
      const res = await call("POST", `/quests/${ctx.id}/video-progress`, {
        timestamp: Math.min(ctx.target, t + Math.random()),
      });
      log(`  video ${Math.floor(t)}/${ctx.target}`);
      if (res?.completed_at) return;
    }
    await sleep(1000);
  }
  await call("POST", `/quests/${ctx.id}/video-progress`, { timestamp: ctx.target });
}

async function runActivity(ctx) {
  const dms = await call("GET", "/users/@me/channels");
  const channelId = dms?.[0]?.id;
  if (!channelId) throw new Error("no DM channel available for the stream key");
  const stream_key = `call:${channelId}:1`;

  for (;;) {
    const res = await call("POST", `/quests/${ctx.id}/heartbeat`, { stream_key, terminal: false });
    const p = res?.progress?.PLAY_ACTIVITY?.value ?? 0;
    log(`  activity ${p}/${ctx.target}`);
    if (p >= ctx.target) {
      await call("POST", `/quests/${ctx.id}/heartbeat`, { stream_key, terminal: true });
      return;
    }
    await sleep(HEARTBEAT_MS);
  }
}

const RUNNERS = {
  WATCH_VIDEO: runVideo,
  WATCH_VIDEO_ON_MOBILE: runVideo,
  PLAY_ACTIVITY: runActivity,
};

// ---------------------------------------------------------------- main loop
async function tick() {
  const data = await call("GET", "/quests/@me");
  const todo = (data?.quests ?? []).map(describe).filter(Boolean);

  if (!todo.length) {
    log("no runnable quests (accept one in Discover -> Quests, then it gets picked up next poll)");
    return;
  }

  log(`${todo.length} quest(s) queued`);
  for (const ctx of todo) {
    log(`-> ${ctx.title} [${ctx.name}]`);
    try {
      await RUNNERS[ctx.name](ctx);
      log(`done: ${ctx.title} - claim it from the Quests tab`);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      log(`failed: ${ctx.title}:`, err.message, err.body ? JSON.stringify(err.body) : "");
      if (err.body?.captcha_key) log("  captcha demanded - stopping this pass");
    }
  }
}

process.on("SIGTERM", () => process.exit(0));

(async () => {
  log(`quest-worker up, polling every ${POLL_MS / 60_000} min`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      if (err instanceof AuthError) {
        log("token invalid or revoked - fix DISCORD_TOKEN and redeploy");
        process.exit(1);
      }
      log("tick error:", err.message);
    }
    await sleep(POLL_MS);
  }
})();

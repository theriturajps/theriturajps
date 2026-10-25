import fs from "node:fs";
import config from "../config.js";

const API = process.env.GITHUB_API_URL || "https://api.github.com";
const GQL = process.env.GITHUB_GRAPHQL_URL || "https://api.github.com/graphql";
const TOKEN = process.env.GITHUB_TOKEN || "";
const USER = config.username || process.env.GITHUB_REPOSITORY_OWNER || process.env.GH_USER;
const README = "README.md";

if (!USER) {
  console.error("No username found. Set `username` in config.js.");
  process.exit(1);
}

const headers = {
  "User-Agent": "profile-readme-bot",
  Accept: "application/vnd.github+json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

/* ---------- helpers ---------- */
async function rest(path) {
  const res = await fetch(`${API}${path}`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const hint =
      res.status === 403 || res.status === 429
        ? " (rate limited? the workflow's token avoids this)"
        : "";
    throw new Error(
      `GitHub API ${res.status} for ${path.split("?")[0]}${hint}`
    );
  }

  return res.json();
}

const clean = (s, max = 90) => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/</g, "&lt;")
    .replace(/[\[\]]/g, "")
    .trim();

  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

const num = (n) => Number(n).toLocaleString("en-US");
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const pad = (n) => String(n).padStart(2, "0");
const dayFmt = (d) =>
  `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

function setSection(md, name, content) {
  const s = `<!-- ${name}:START -->`;
  const e = `<!-- ${name}:END -->`;

  if (!md.includes(s) || !md.includes(e)) {
    console.warn(`Marker ${name} not found in README, skipped.`);
    return md;
  }

  return md.replace(
    new RegExp(`${s}[\\s\\S]*?${e}`),
    () => `${s}\n${content}\n${e}`
  );
}

/* ---------- data ---------- */
async function getRepos() {
  const all = [];

  for (let page = 1; page <= 3; page++) {
    const batch = await rest(
      `/users/${USER}/repos?per_page=100&sort=pushed&type=owner&page=${page}`
    );

    all.push(...batch);
    if (batch.length < 100) break;
  }

  return all;
}

async function getLanguages(repos) {
  const totals = {};
  const pick = repos
    .filter((r) => !r.fork && !r.archived)
    .slice(0, 30);

  await Promise.all(
    pick.map(async (r) => {
      try {
        const langs = await rest(`/repos/${USER}/${r.name}/languages`);

        for (const [lang, bytes] of Object.entries(langs)) {
          totals[lang] = (totals[lang] ?? 0) + bytes;
        }
      } catch (e) {
        console.warn(`Languages skipped for ${r.name}: ${e.message}`);
      }
    })
  );

  return totals;
}

// Needs a token. Returns null if unavailable so the rest of the README still updates.
async function getContributions() {
  if (!TOKEN) return null;

  try {
    const res = await fetch(GQL, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        query: `query($login:String!){user(login:$login){contributionsCollection{totalCommitContributions totalPullRequestContributions totalIssueContributions totalPullRequestReviewContributions contributionCalendar{totalContributions weeks{contributionDays{date contributionCount weekday}}}}}}`,
        variables: { login: USER },
      }),
    });

    const json = await res.json();
    const cc = json?.data?.user?.contributionsCollection;
    const cal = cc?.contributionCalendar;

    if (!cal) {
      throw new Error(json?.errors?.[0]?.message ?? `HTTP ${res.status}`);
    }

    const days = cal.weeks
      .flatMap((w) => w.contributionDays)
      .sort((a, b) => a.date.localeCompare(b.date));

    let longest = 0;
    let run = 0;

    for (const d of days) {
      run = d.contributionCount > 0 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }

    let i = days.length - 1;
    if (i >= 0 && days[i].contributionCount === 0) i--;

    let current = 0;
    while (i >= 0 && days[i].contributionCount > 0) {
      current++;
      i--;
    }

    return {
      total: cal.totalContributions,
      current,
      longest,
      commits: cc.totalCommitContributions ?? 0,
      prs: cc.totalPullRequestContributions ?? 0,
      issues: cc.totalIssueContributions ?? 0,
      reviews: cc.totalPullRequestReviewContributions ?? 0,
      weeks: cal.weeks,
      days,
    };
  } catch (e) {
    console.warn(`Contribution data skipped: ${e.message}`);
    return null;
  }
}

async function getPosts() {
  if (!config.rssFeed) return [];

  try {
    const res = await fetch(config.rssFeed, {
      headers: { "User-Agent": "profile-readme-bot" },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);

    const xml = await res.text();

    const decode = (s) =>
      s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .trim();

    return [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)]
      .slice(0, config.rssPosts)
      .map((m) => {
        const b = m[0];
        const title = decode(
          b.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? ""
        );
        const link = decode(
          b.match(/<link[^>]*href="([^"]+)"/)?.[1] ??
          b.match(/<link>([\s\S]*?)<\/link>/)?.[1] ??
          ""
        );
        const raw = b.match(/<(?:pubDate|published|updated)>([\s\S]*?)</)?.[1];
        const date =
          raw && !Number.isNaN(Date.parse(raw))
            ? dayFmt(new Date(raw))
            : "";

        return { title, link, date };
      })
      .filter((p) => p.title && p.link);
  } catch (e) {
    console.warn(`Posts skipped: ${e.message}`);
    return [];
  }
}

/* ---------- recent activity feed (public events) ---------- */
const ago = (iso) => {
  const mins = Math.max(
    1,
    Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  );

  if (mins < 60) return `${mins} min ago`;

  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;

  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
};

async function getFeed() {
  const limit = config.feedItems ?? 5;
  const hidden = new Set([
    `${USER}/${USER}`.toLowerCase(),
    ...(config.hideFromFeed ?? []).map((n) => `${USER}/${n}`.toLowerCase()),
  ]);

  try {
    const events = await rest(`/users/${USER}/events/public?per_page=100`);
    const seen = new Set();
    const items = [];

    for (const ev of events) {
      const repo = ev.repo?.name;
      if (!repo || hidden.has(repo.toLowerCase())) continue;

      const p = ev.payload ?? {};
      const link = `[${repo.startsWith(`${USER}/`) ? repo.slice(USER.length + 1) : repo}](https://github.com/${repo})`;

      let key;
      let text;

      switch (ev.type) {
        case "PushEvent": {
          const n = p.size ?? p.commits?.length;
          key = `push:${repo}`;
          text = `⬆️ Pushed ${n ? `${n} commit${n > 1 ? "s" : ""}` : "changes"} to ${link}`;
          break;
        }

        case "PullRequestEvent": {
          const merged = p.action === "closed" && p.pull_request?.merged;
          const verb = merged
            ? "Merged"
            : p.action === "opened"
              ? "Opened"
              : p.action === "closed"
                ? "Closed"
                : null;

          if (!verb) continue;

          key = `pr:${repo}:${p.number}:${verb}`;
          text = `🔀 ${verb} PR #${p.number} in ${link}`;
          break;
        }

        case "PullRequestReviewEvent":
          key = `review:${repo}:${p.pull_request?.number}`;
          text = `👀 Reviewed PR #${p.pull_request?.number} in ${link}`;
          break;

        case "IssuesEvent":
          if (p.action !== "opened") continue;
          key = `issue:${repo}:${p.issue?.number}`;
          text = `🐛 Opened issue #${p.issue?.number} in ${link}`;
          break;

        case "IssueCommentEvent":
          key = `comment:${repo}:${p.issue?.number}`;
          text = `💬 Commented on #${p.issue?.number} in ${link}`;
          break;

        case "CreateEvent":
          key = `create:${repo}:${p.ref_type}:${p.ref}`;
          text =
            p.ref_type === "repository"
              ? `🆕 Created ${link}`
              : `🌿 Created ${p.ref_type} \`${clean(p.ref, 30)}\` in ${link}`;
          break;

        case "ForkEvent":
          key = `fork:${repo}`;
          text = `🍴 Forked ${link}`;
          break;

        case "WatchEvent":
          key = `star:${repo}`;
          text = `⭐ Starred ${link}`;
          break;

        case "ReleaseEvent":
          key = `release:${repo}:${p.release?.tag_name}`;
          text = `🏷️ Released ${clean(p.release?.tag_name, 30)} of ${link}`;
          break;

        default:
          continue;
      }

      if (seen.has(key)) continue;
      seen.add(key);
      items.push(`- ${text} · ${ago(ev.created_at)}`);

      if (items.length >= limit) break;
    }

    return items;
  } catch (e) {
    console.warn(`Activity feed skipped: ${e.message}`);
    return [];
  }
}

/* ---------- colorful full-year contribution heatmap ---------- */
function buildActivity(c) {
  if (!c?.days?.length || c.total === 0) {
    if (fs.existsSync("activity-heatmap.svg")) {
      fs.unlinkSync("activity-heatmap.svg");
    }
    return "";
  }

  // Display the last 53 weeks (approximately 12 months).
  const N = config.heatmapWeeks ?? 53;
  const weeks = c.weeks.slice(-N);

  const COLORS = [
    "#161B22",
    "#00BFFF",
    "#8A2BE2",
    "#FF1493",
    "#FF8C00",
  ];

  const CELL = 12;
  const GAP = 4;
  const STEP = CELL + GAP;
  const LEFT = 34;
  const TOP = 30;

  const width = LEFT + weeks.length * STEP + 12;
  const height = TOP + 7 * STEP + 30;

  const counts = weeks.flatMap((week) =>
    week.contributionDays.map((day) => day.contributionCount)
  );
  const max = Math.max(1, ...counts);

  const getLevel = (count) =>
    count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));

  const escapeXML = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    })[char]);

  const shortDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  const cells = [];
  const monthLabels = [];
  const seenMonths = new Set();

  weeks.forEach((week, column) => {
    const x = LEFT + column * STEP;

    // Label a month in the week containing its first day.
    const monthStart = week.contributionDays.find((day) => {
      const date = new Date(`${day.date}T00:00:00Z`);
      return date.getUTCDate() === 1;
    });

    if (monthStart) {
      const date = new Date(`${monthStart.date}T00:00:00Z`);
      const monthKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;

      if (!seenMonths.has(monthKey)) {
        seenMonths.add(monthKey);
        monthLabels.push(
          `<text x="${x}" y="17" fill="#9CA3AF" font-size="10">${monthNames[date.getUTCMonth()]}</text>`
        );
      }
    }

    week.contributionDays.forEach((day) => {
      const y = TOP + day.weekday * STEP;
      const color = COLORS[getLevel(day.contributionCount)];

      cells.push(`
        <rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="3" fill="${color}">
          <title>${escapeXML(day.contributionCount)} contributions on ${escapeXML(day.date)}</title>
        </rect>
      `);
    });
  });

  const dayLabels = shortDays
    .map((day, index) => {
      if (index % 2 !== 0) return "";
      return `<text x="0" y="${TOP + index * STEP + 9}" fill="#9CA3AF" font-size="10">${day}</text>`;
    })
    .join("");

  const legend = COLORS
    .map((color, index) =>
      `<rect x="${LEFT + index * STEP}" y="${height - 17}" width="10" height="10" rx="3" fill="${color}"/>`
    )
    .join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}"
     height="${height}"
     viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" rx="10" fill="#0D1117"/>
  ${monthLabels.join("")}
  ${dayLabels}
  ${cells.join("")}
  ${legend}
  <text x="${LEFT + COLORS.length * STEP + 4}" y="${height - 9}" fill="#9CA3AF" font-size="10">More</text>
</svg>`.trim();

  fs.writeFileSync("activity-heatmap.svg", svg, "utf8");

  // Calculate activity statistics using the full contribution calendar.
  const byDay = Array(7).fill(0);

  for (const day of c.days) {
    byDay[day.weekday] += day.contributionCount;
  }

  const topDay = byDay.indexOf(Math.max(...byDay));

  const best = c.days.reduce(
    (a, b) => b.contributionCount > a.contributionCount ? b : a,
    c.days[0]
  );

  return [
    "## Activity Heatmap",
    "",
    "![Colorful GitHub Contribution Heatmap](./activity-heatmap.svg)",
    "",
    `- Most active day: **${shortDays[topDay]}**`,
    `- Best day: **${best.contributionCount} contributions** on ${dayFmt(new Date(best.date))}`,
  ].join("\n");
}

/* ---------- build sections ---------- */
const [profile, repos] = await Promise.all([
  rest(`/users/${USER}`),
  getRepos(),
]);

const own = repos.filter((r) => !r.fork && !config.hideRepos.includes(r.name));

const [langTotals, contrib, posts, feed] = await Promise.all([
  getLanguages(own),
  getContributions(),
  getPosts(),
  getFeed(),
]);

/* ---------- GitHub stats ---------- */
const stars = own.reduce((n, r) => n + r.stargazers_count, 0);
const forks = own.reduce((n, r) => n + r.forks_count, 0);
const now = new Date();
const stamp = `${dayFmt(now)}, ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;

const stats = [
  "## 📊 GitHub Stats",
  "",
  `- 📦 **${num(profile.public_repos)}** public repos`,
  `- ⭐ **${num(stars)}** stars earned`,
  `- 🍴 **${num(forks)}** forks`,
  `- 👥 **${num(profile.followers)}** followers`,
];

if (profile.created_at) {
  stats.push(
    `- 🗓️ On GitHub since **${new Date(profile.created_at).getUTCFullYear()}**`
  );
}

if (contrib) {
  stats.push(
    `- 📈 **${num(contrib.total)}** contributions in the last year`,
    `- 🔨 **${num(contrib.commits)}** commits · **${num(contrib.prs)}** PRs · **${num(contrib.issues)}** issues · **${num(contrib.reviews)}** reviews`,
    `- 🔥 **${contrib.current}** day streak (longest **${contrib.longest}**)`
  );
}

stats.push("", `<sub>Updated ${stamp}</sub>`);

/* ---------- visual Top Languages chart ---------- */
const langs = Object.entries(langTotals)
  .filter(([language]) => !config.hideLanguages.includes(language))
  .sort((a, b) => b[1] - a[1]);

const langSum = langs.reduce((total, [, bytes]) => total + bytes, 0);
let langSection = "";

if (langSum > 0) {
  const top = langs.slice(0, config.languages).map(([name, bytes]) => ({
    name,
    percent: (bytes / langSum) * 100,
  }));

  const colors = [
    "#3572A5",
    "#F1E05A",
    "#E34C26",
    "#563D7C",
    "#3178C6",
    "#DA5B0B",
    "#00ADD8",
    "#89E051",
  ];

  const escapeXML = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    })[char]);

  const width = 760;
  const rowHeight = 38;
  const topOffset = 48;
  const height = topOffset + top.length * rowHeight + 18;
  const labelX = 18;
  const barX = 190;
  const barWidth = 430;
  const percentX = 735;

  const rows = top.map((item, index) => {
    const y = topOffset + index * rowHeight;
    const fillWidth = Math.max(2, barWidth * item.percent / 100);
    const color = colors[index % colors.length];

    return [
      `<text x="${labelX}" y="${y + 15}" fill="#E6EDF3" font-size="13">${escapeXML(item.name)}</text>`,
      `<rect x="${barX}" y="${y}" width="${barWidth}" height="12" rx="6" fill="#21262D"/>`,
      `<rect x="${barX}" y="${y}" width="${fillWidth.toFixed(2)}" height="12" rx="6" fill="${color}"/>`,
      `<text x="${percentX}" y="${y + 11}" text-anchor="end" fill="#9CA3AF" font-size="12">${item.percent.toFixed(1)}%</text>`,
    ].join("\n");
  }).join("\n");

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg"
      width="${width}"
      height="${height}"
      viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" rx="10" fill="#0D1117"/>
    <text x="18" y="25" fill="#E6EDF3" font-size="14" font-weight="600">Most Used Languages</text>
    ${rows}
  </svg>`.trim();

  fs.writeFileSync("top-languages.svg", svg, "utf8");

  langSection = [
    "## 💻 Top Languages",
    "",
    "![Top Languages](./top-languages.svg)",
  ].join("\n");
} else {
  langSection = "";
  if (fs.existsSync("top-languages.svg")) {
    fs.unlinkSync("top-languages.svg");
  }
}

/* ---------- recently updated repositories ---------- */
const recent = own
  .filter((r) => !r.archived && r.name.toLowerCase() !== USER.toLowerCase())
  .slice(0, config.recentRepos);

let repoSection = "";

if (recent.length) {
  const items = recent.map((r) => {
    const meta = [
      r.stargazers_count ? `⭐ ${r.stargazers_count}` : "",
      r.language ?? "",
    ].filter(Boolean).join(" · ");

    const desc = r.description ? `<br>${clean(r.description)}` : "";

    return `- **[${r.name}](${r.html_url})**${meta ? " · " + meta : ""}${desc}`;
  });

  repoSection = ["## 🚀 Recently Updated", "", ...items].join("\n");
}

/* ---------- activity feed ---------- */
const feedSection = feed.length
  ? ["## ⚡ Recent Activity", "", ...feed].join("\n")
  : "";

/* ---------- latest posts ---------- */
const postSection = posts.length
  ? [
    "## ✍️ Latest Posts",
    "",
    ...posts.map(
      (p) => `- [${clean(p.title, 80)}](${p.link})${p.date ? ` · ${p.date}` : ""}`
    ),
  ].join("\n")
  : "";

/* ---------- write README ---------- */
let md = fs.readFileSync(README, "utf8");

md = setSection(md, "STATS", stats.join("\n"));
md = setSection(md, "ACTIVITY", buildActivity(contrib));
md = setSection(md, "LANGS", langSection);
md = setSection(md, "REPOS", repoSection);
md = setSection(md, "FEED", feedSection);
md = setSection(md, "POSTS", postSection);

fs.writeFileSync(README, md);

console.log(
  `Updated README for ${USER}: ${own.length} repos, ${langs.length} languages, streak ${contrib ? "ok" : "n/a"}, ${posts.length} posts, ${feed.length} feed items`
);
# ⚾ On Deck

Daily trivia with baseball scoring. AI generates fresh questions every day.
No account needed to play. Share your score with friends via text.

**Suggested domains:** `playondeck.com` · `ondeck.app` · `ondeckdaily.com`

## Deploy in 5 steps

### 1. Get an Anthropic API key
Go to [console.anthropic.com](https://console.anthropic.com) → API Keys → Create key.

### 2. Create a GitHub repository
- Go to [github.com](https://github.com) and create a free account if needed
- Click **New repository**, name it `on-deck`, make it private, click **Create**
- Upload all four files from this folder: `index.html`, `netlify.toml`, `package.json`, and the `netlify/` folder

### 3. Connect to Netlify
- Go to [netlify.com](https://netlify.com) and sign up for free
- Click **Add new site → Import an existing project**
- Connect your GitHub account and select the `on-deck` repo
- Leave all build settings as-is and click **Deploy site**

### 4. Add your API key
- In Netlify, go to **Site configuration → Environment variables**
- Click **Add a variable**
- Key: `ANTHROPIC_API_KEY`
- Value: your key from step 1
- Click **Save**, then go to **Deploys → Trigger deploy → Deploy site**

### 5. Add your URL to the share text (optional)
- Once deployed, Netlify gives you a URL like `sparkly-game-abc123.netlify.app`
- You can get a custom domain in Netlify settings (e.g. `playondeck.com`)
- Open `index.html`, find this line near the bottom and add your URL:
  ```javascript
  const GAME_URL = ''; // ← e.g. 'playondeck.com'
  ```
- Commit the change and Netlify will auto-redeploy

---

## How it works

**Questions:** On the first visit each day, Claude generates ~52 fresh questions (15 easy,
15 medium, 12 hard, 10 expert) and caches them in Netlify Blobs. Every subsequent player
that day gets the same questions instantly from cache. If a player exhausts any pool,
12 more are generated on demand and added to the cache.

**Daily reset:** Each day's cache is keyed by date, so questions automatically refresh.
Players' scores are stored in their browser (localStorage) — no database needed.

**Costs:** Each daily question generation costs roughly $0.01–0.03 in API credits.
With normal usage, monthly costs should be under $1.

## File structure

```
on-deck/
├── index.html                    ← The game (single-page app)
├── netlify.toml                  ← Netlify configuration
├── package.json                  ← Node.js dependencies
└── netlify/
    └── functions/
        └── questions.js          ← Serverless API (question generation + caching)
```

# Deploy to Render (Free Tier)

## Option A: GitHub → Render (Recommended)

### Step 1: Create a GitHub repo
1. Go to https://github.com/new
2. Name it `hms-command-center`
3. Make it private or public (your choice)
4. **Do NOT** initialize with README, .gitignore, or license
5. Click "Create repository"

### Step 2: Push code from this server
```bash
cd ~/.openclaw/workspace/hms-command-center
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/hms-command-center.git
git push -u origin main
```

### Step 3: Deploy on Render
1. Go to https://dashboard.render.com/
2. Click **New +** → **Blueprint**
3. Connect your GitHub account if not already connected
4. Find and select `hms-command-center` repo
5. Render will auto-detect `render.yaml` and configure everything
6. Click **Apply**
7. Wait 2-3 minutes for build + deploy
8. You'll get a URL like `https://hms-command-center.onrender.com`

### Step 4: Done
Your URL is permanent. It sleeps after 15 min of inactivity (free tier), wakes up in ~30 sec on next visit.

---

## Option B: Direct Web Service (No Blueprint)

If the Blueprint doesn't work:

1. Go to https://dashboard.render.com/
2. Click **New +** → **Web Service**
3. Connect GitHub, select repo
4. Fill in:
   - **Name:** `hms-command-center`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Click **Create Web Service**
6. Done in ~3 minutes

---

## Updating After Deploy

Every time you push to GitHub:
```bash
git add .
git commit -m "Your changes"
git push origin main
```
Render auto-deploys on every push.

---

## Data Persistence on Render

The free tier has **ephemeral disk**. Your `data/command-center.json` will reset on every deploy or restart.

**For production persistence, options:**
1. **Render Disk** ($0.25/GB/month) — add a disk mount in dashboard
2. **MongoDB Atlas** (free 512MB) — swap JSON for Mongo
3. **PostgreSQL on Render** (free tier) — structured, reliable

For now, the free web service works for testing. Add persistent storage when you're ready.

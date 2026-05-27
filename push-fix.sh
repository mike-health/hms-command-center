#!/bin/bash
cd /root/.openclaw/workspace/hms-command-center
git config user.email "deploy@hms.local"
git config user.name "HMS Deploy"
git add .
git commit -m "Fix static file serving for Render deploy"
git push origin main

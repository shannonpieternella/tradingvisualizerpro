#!/bin/bash
# Serve the built React dashboard using Vite preview (production)
# Or: install 'serve' globally: npm install -g serve && serve -s dist -l 5173
cd /opt/trading-assistant/dashboard
exec npx vite preview --host 0.0.0.0 --port 5173 >> /opt/trading-assistant/logs/dashboard.log 2>&1

#!/bin/bash
cd /opt/trading-assistant/api
exec node server.js >> /opt/trading-assistant/logs/api.log 2>&1

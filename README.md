# CerebroTasks Server v1.2

This build adds the first Todoist connection layer.

## New routes
- GET /todoist/status
- GET /todoist/connect
- GET /todoist/callback
- POST /todoist/webhook
- GET /obsidian/changes

## New table
- integrations

## Required Railway variables
- DATABASE_URL
- APP_BASE_URL
- TODOIST_CLIENT_ID
- TODOIST_CLIENT_SECRET

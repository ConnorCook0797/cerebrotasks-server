# CerebroTasks Server v1.2.1

Patch release for Todoist OAuth.

## Fixes
- Correct Todoist authorize URL host: app.todoist.com
- Better callback error handling for missing code / explicit OAuth errors

## Routes
- GET /todoist/status
- GET /todoist/connect
- GET /todoist/callback
- POST /todoist/webhook

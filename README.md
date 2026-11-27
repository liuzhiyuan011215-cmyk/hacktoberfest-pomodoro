# Hacktoberfest Pomodoro + Task Tracker

A small, polished, fully offline single-page web app that combines a Pomodoro focus timer with a lightweight task tracker, wrapped in a dark Hacktoberfest-inspired purple/orange theme.

## Features
- Pomodoro timer (default 25 min focus / 5 min break) with start, pause and reset
- Custom focus/break durations
- Animated circular progress ring
- Task list: add, complete, delete, and pick an active task
- Per-task pomodoro counter and completed-session stats
- Everything saved in `localStorage`, so state survives reloads
- Space bar starts/pauses the timer
- Gentle WebAudio beep when a session ends (no audio files)
- Responsive layout, no external dependencies or CDNs

## Run it
No build step. Either open `index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Files
- `index.html`: markup
- `style.css`: styles and theme
- `app.js`: timer, tasks, persistence, audio

---
Built with Grok Build during MLH Global Hack Week: Hacktoberfest 2026

**본인 역할 (한국어)**: MLH Global Hack Week 개인 참가작 — 기능 구성과 브라우저 동작 확인을 직접 했고, 코드는 AI 코딩 도구(Grok Build)로 작성했습니다.

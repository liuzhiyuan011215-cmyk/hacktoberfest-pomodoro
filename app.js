(function () {
  "use strict";

  var STORAGE_KEY = "hf-pomodoro-v1";
  var MAX_SESSIONS = 400;
  var MAX_TASKS = 200;
  var MIN_MINUTES = 1;
  var MAX_MINUTES = 180;
  var RADIUS = 86;
  var CIRC = 2 * Math.PI * RADIUS;

  var els = {};
  var state = null;
  var storageOk = true;
  var tickTimer = null;
  var audioCtx = null;
  var scheduledNodes = [];
  var armedChimeRunId = null;
  var completing = false;
  var undo = null;
  var undoTimer = null;
  var toastTimer = null;
  var justAddedId = null;
  var renderedDay = "";

  function byId(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      ["todayLabel", "today-label"],
      ["timerCard", "timer-card"],
      ["modeFocus", "mode-focus"],
      ["modeBreak", "mode-break"],
      ["ringWidget", "ring-widget"],
      ["progress", "ring-progress"],
      ["modeLabel", "mode-label"],
      ["time", "time-display"],
      ["timerState", "timer-state"],
      ["startBtn", "start-btn"],
      ["startLabel", "start-label"],
      ["pauseBtn", "pause-btn"],
      ["resetBtn", "reset-btn"],
      ["focusMin", "focus-min"],
      ["breakMin", "break-min"],
      ["durationHint", "duration-hint"],
      ["presets", "presets"],
      ["sound", "sound-toggle"],
      ["activeTask", "active-task"],
      ["statToday", "stat-today"],
      ["statMinutes", "stat-minutes"],
      ["statTotal", "stat-total"],
      ["week", "week"],
      ["breakLine", "break-line"],
      ["taskForm", "task-form"],
      ["taskInput", "task-input"],
      ["taskError", "task-error"],
      ["openCount", "open-count"],
      ["taskEmpty", "task-empty"],
      ["taskList", "task-list"],
      ["toast", "toast"],
      ["live", "live"],
      ["storageNote", "storage-note"]
    ].forEach(function (pair) {
      els[pair[0]] = byId(pair[1]);
    });
  }

  function defaultState() {
    var focusMs = 25 * 60 * 1000;
    return {
      version: 1,
      settings: { focusMin: 25, breakMin: 5, sound: true },
      timer: { mode: "focus", running: false, durationMs: focusMs, remainingMs: focusMs, endsAt: null, runId: null },
      tasks: [],
      activeTaskId: null,
      stats: { sessions: [] }
    };
  }

  function uid() {
    if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function clampMinutes(value, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)));
  }

  function fullMs(mode, settings) {
    return (mode === "break" ? settings.breakMin : settings.focusMin) * 60 * 1000;
  }

  function armMode(target, mode) {
    var ms = fullMs(mode, target.settings);
    target.timer = { mode: mode, running: false, durationMs: ms, remainingMs: ms, endsAt: null, runId: null };
  }

  function creditTask(target, taskId) {
    if (!taskId) return;
    var task = target.tasks.find(function (item) { return item.id === taskId; });
    if (task) task.pomodoros = Math.min(9999, task.pomodoros + 1);
  }

  function pushSession(target, session) {
    target.stats.sessions.push(session);
    if (target.stats.sessions.length > MAX_SESSIONS) {
      target.stats.sessions = target.stats.sessions.slice(-MAX_SESSIONS);
    }
  }

  function normalize(raw) {
    var next = defaultState();
    var awayNote = null;
    if (!raw || typeof raw !== "object") return { state: next, awayNote: awayNote };

    var settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    next.settings.focusMin = clampMinutes(settings.focusMin, 25);
    next.settings.breakMin = clampMinutes(settings.breakMin, 5);
    next.settings.sound = settings.sound !== false;

    (Array.isArray(raw.tasks) ? raw.tasks : []).forEach(function (item) {
      if (next.tasks.length >= MAX_TASKS || !item || typeof item.title !== "string" || !item.id) return;
      var title = item.title.trim().slice(0, 140);
      if (!title) return;
      var pomodoros = Math.round(Number(item.pomodoros));
      next.tasks.push({
        id: String(item.id).slice(0, 80),
        title: title,
        done: Boolean(item.done),
        pomodoros: Number.isFinite(pomodoros) ? Math.min(9999, Math.max(0, pomodoros)) : 0,
        createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now()
      });
    });

    var wantedActive = raw.activeTaskId ? String(raw.activeTaskId) : null;
    next.activeTaskId = next.tasks.some(function (task) { return task.id === wantedActive; }) ? wantedActive : null;

    var sessions = [];
    var sessionsIn = raw.stats && Array.isArray(raw.stats.sessions) ? raw.stats.sessions : [];
    sessionsIn.forEach(function (item) {
      if (!item || (item.type !== "focus" && item.type !== "break")) return;
      var completedAt = Number(item.completedAt);
      var durationMs = Number(item.durationMs);
      if (!Number.isFinite(completedAt) || completedAt < 0) return;
      sessions.push({
        id: item.id ? String(item.id).slice(0, 80) : uid(),
        runId: item.runId ? String(item.runId).slice(0, 80) : null,
        type: item.type,
        completedAt: completedAt,
        durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.min(MAX_MINUTES * 60000, durationMs)) : 0,
        taskId: item.taskId ? String(item.taskId).slice(0, 80) : null
      });
    });
    sessions.sort(function (a, b) { return a.completedAt - b.completedAt; });
    next.stats.sessions = sessions.slice(-MAX_SESSIONS);

    var timerIn = raw.timer && typeof raw.timer === "object" ? raw.timer : {};
    var mode = timerIn.mode === "break" ? "break" : "focus";
    var durationMs = Number(timerIn.durationMs);
    if (!Number.isFinite(durationMs)) durationMs = fullMs(mode, next.settings);
    durationMs = Math.min(MAX_MINUTES * 60000, Math.max(1000, durationMs));
    var remainingMs = Number(timerIn.remainingMs);
    if (!Number.isFinite(remainingMs)) remainingMs = durationMs;
    remainingMs = Math.min(durationMs, Math.max(0, remainingMs));
    var running = Boolean(timerIn.running);
    var endsAt = Number(timerIn.endsAt);
    if (!Number.isFinite(endsAt)) endsAt = null;
    var runId = timerIn.runId ? String(timerIn.runId).slice(0, 80) : null;

    if (running && endsAt) {
      var rem = endsAt - Date.now();
      if (rem <= 0) {
        var already = runId && next.stats.sessions.some(function (session) { return session.runId === runId; });
        if (!already) {
          pushSession(next, {
            id: uid(),
            runId: runId,
            type: mode,
            completedAt: endsAt,
            durationMs: durationMs,
            taskId: mode === "focus" ? next.activeTaskId : null
          });
          if (mode === "focus") creditTask(next, next.activeTaskId);
          awayNote = mode === "focus"
            ? "A focus session finished while this page was closed. It has been counted."
            : "A break finished while this page was closed.";
        }
        armMode(next, mode === "focus" ? "break" : "focus");
      } else {
        next.timer = { mode: mode, running: true, durationMs: durationMs, remainingMs: rem, endsAt: endsAt, runId: runId };
      }
    } else if (!running && Math.abs(remainingMs - durationMs) < 500) {
      armMode(next, mode);
    } else {
      next.timer = { mode: mode, running: false, durationMs: durationMs, remainingMs: remainingMs, endsAt: null, runId: null };
    }

    return { state: next, awayNote: awayNote };
  }

  function readState() {
    var raw = null;
    try {
      var text = localStorage.getItem(STORAGE_KEY);
      if (text) raw = JSON.parse(text);
    } catch (err) {
      storageOk = false;
    }
    return normalize(raw);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (!storageOk) {
        storageOk = true;
        renderStorageNote();
      }
    } catch (err) {
      storageOk = false;
      renderStorageNote();
    }
  }

  function dayKey(ts) {
    var date = new Date(ts);
    return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
  }

  function formatLongDate(date) {
    return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }

  function formatTime(ms) {
    var totalSeconds = Math.floor((Math.max(0, ms) + 999) / 1000);
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  }

  function formatMinutes(total) {
    var mins = Math.max(0, Math.round(total));
    var hours = Math.floor(mins / 60);
    var rem = mins % 60;
    return hours <= 0 ? rem + "m" : hours + "h " + rem + "m";
  }

  function modeLabel(mode) {
    return mode === "break" ? "Break" : "Focus";
  }

  function pomoPhrase(count) {
    if (count === 0) return "No pomodoros yet";
    return count === 1 ? "1 pomodoro" : count + " pomodoros";
  }

  function sessionIsPristine() {
    return !state.timer.running && Math.abs(state.timer.remainingMs - state.timer.durationMs) < 500;
  }

  function elapsedFraction() {
    var duration = state.timer.durationMs;
    if (!duration) return 0;
    return Math.min(1, Math.max(0, 1 - state.timer.remainingMs / duration));
  }

  function cssEscape(value) {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function announce(message) {
    els.live.textContent = "";
    window.setTimeout(function () { els.live.textContent = message; }, 20);
  }

  function showToast(message, options) {
    var withUndo = Boolean(options && options.undo);
    if (!withUndo) {
      undo = null;
      if (undoTimer) clearTimeout(undoTimer);
      undoTimer = null;
    }
    els.toast.replaceChildren();
    var text = document.createElement("span");
    text.textContent = message;
    els.toast.appendChild(text);
    if (withUndo) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "toast-undo";
      button.textContent = "Undo";
      button.addEventListener("click", undoDelete);
      els.toast.appendChild(button);
    }
    els.toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, withUndo ? 5000 : 3200);
  }

  function renderStorageNote() {
    els.storageNote.hidden = storageOk;
  }

  function renderSettings() {
    if (document.activeElement !== els.focusMin) els.focusMin.value = String(state.settings.focusMin);
    if (document.activeElement !== els.breakMin) els.breakMin.value = String(state.settings.breakMin);
    els.sound.checked = state.settings.sound;
    els.modeFocus.textContent = "Focus · " + state.settings.focusMin + "m";
    els.modeBreak.textContent = "Break · " + state.settings.breakMin + "m";
  }

  function renderPresets() {
    Array.prototype.forEach.call(els.presets.querySelectorAll("[data-preset]"), function (chip) {
      var parts = chip.dataset.preset.split(",");
      var on = state.settings.focusMin === Number(parts[0]) && state.settings.breakMin === Number(parts[1]);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function renderHint() {
    els.durationHint.textContent = sessionIsPristine()
      ? "These lengths apply to the session you are about to start."
      : "Length changes apply to the next full session. Reset to use them now.";
  }

  function renderTimer() {
    var remaining = formatTime(state.timer.remainingMs);
    var mode = state.timer.mode;
    var name = modeLabel(mode);
    var fraction = elapsedFraction();
    var pct = Math.round(fraction * 100);

    els.time.textContent = remaining;
    els.modeLabel.textContent = name;
    els.timerCard.dataset.mode = mode;
    els.timerCard.dataset.running = state.timer.running ? "true" : "false";
    els.modeFocus.setAttribute("aria-pressed", mode === "focus" ? "true" : "false");
    els.modeBreak.setAttribute("aria-pressed", mode === "break" ? "true" : "false");
    els.timerState.textContent = state.timer.running
      ? "In progress · " + pct + "%"
      : (sessionIsPristine() ? "Ready" : "Paused · " + pct + "%");

    els.progress.style.strokeDasharray = String(CIRC);
    els.progress.style.strokeDashoffset = String(CIRC * (1 - fraction));
    els.progress.style.opacity = fraction <= 0.001 ? "0" : "1";
    els.progress.setAttribute("stroke", mode === "break" ? "url(#grad-break)" : "url(#grad-focus)");
    els.ringWidget.setAttribute("aria-valuenow", String(pct));
    els.ringWidget.setAttribute("aria-label", name + " session progress");
    els.ringWidget.setAttribute("aria-valuetext", remaining + " remaining");

    els.startBtn.disabled = state.timer.running;
    els.pauseBtn.disabled = !state.timer.running;
    els.resetBtn.disabled = sessionIsPristine();
    els.startBtn.classList.toggle("btn-primary", !state.timer.running);
    els.pauseBtn.classList.toggle("btn-primary", state.timer.running);
    els.startLabel.textContent = mode === "break" ? "Start break" : "Start focus";
    document.title = remaining + " · " + (state.timer.running || sessionIsPristine() ? name : "Paused") + " — Hacktoberfest Pomodoro";
  }

  function renderActive() {
    var task = state.tasks.find(function (item) { return item.id === state.activeTaskId; });
    if (!task) {
      els.activeTask.textContent = state.timer.mode === "focus"
        ? "No task selected. Finished focus sessions still land in your stats."
        : "No task selected.";
      return;
    }
    var detail = pomoPhrase(task.pomodoros) + (task.done ? " · done" : "");
    els.activeTask.textContent = state.timer.mode === "break"
      ? "Up next: " + task.title + ". " + detail + ". Break time stays off the task count."
      : "Crediting " + task.title + ". " + detail + ".";
  }

  function taskNode(task) {
    var isActive = task.id === state.activeTaskId;
    var li = document.createElement("li");
    li.className = "task" + (task.id === justAddedId ? " just-added" : "");
    if (task.done) li.dataset.done = "true";
    if (isActive) li.dataset.active = "true";

    var label = document.createElement("label");
    label.className = "check";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = task.done;
    input.dataset.action = "toggle";
    input.dataset.taskId = task.id;
    input.setAttribute("aria-label", (task.done ? "Mark “" + task.title + "” incomplete" : "Mark “" + task.title + "” complete"));
    var box = document.createElement("span");
    box.className = "box";
    box.setAttribute("aria-hidden", "true");
    label.append(input, box);

    var select = document.createElement("button");
    select.type = "button";
    select.className = "task-select";
    select.dataset.action = "select";
    select.dataset.taskId = task.id;
    select.setAttribute("aria-pressed", isActive ? "true" : "false");
    select.setAttribute("aria-label", isActive ? "Stop crediting " + task.title : "Credit pomodoros to " + task.title);
    var title = document.createElement("span");
    title.className = "task-title";
    title.textContent = task.title;
    var meta = document.createElement("span");
    meta.className = "task-meta";
    var bits = [];
    if (isActive) bits.push("Active");
    bits.push(pomoPhrase(task.pomodoros));
    if (task.done) bits.push("Done");
    meta.textContent = bits.join(" · ");
    select.append(title, meta);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.dataset.action = "delete";
    remove.dataset.taskId = task.id;
    remove.setAttribute("aria-label", "Delete " + task.title);
    remove.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M8 7l1 12h6l1-12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    li.append(label, select, remove);
    return li;
  }

  function focusTaskControl(id, action) {
    var node = els.taskList.querySelector('[data-action="' + action + '"][data-task-id="' + cssEscape(id) + '"]');
    if (node) node.focus({ preventScroll: true });
  }

  function renderTasks() {
    var open = [];
    var done = [];
    state.tasks.forEach(function (task) { (task.done ? done : open).push(task); });
    els.openCount.textContent = open.length === 1 ? "1 open" : open.length + " open";
    els.taskEmpty.hidden = state.tasks.length !== 0;
    els.taskList.hidden = state.tasks.length === 0;
    els.taskList.replaceChildren();
    open.forEach(function (task) { els.taskList.appendChild(taskNode(task)); });
    if (open.length && done.length) {
      var divider = document.createElement("li");
      divider.className = "divider";
      divider.textContent = "Completed";
      els.taskList.appendChild(divider);
    }
    done.forEach(function (task) { els.taskList.appendChild(taskNode(task)); });
    justAddedId = null;
  }

  function renderStats() {
    var today = dayKey(Date.now());
    var focusToday = state.stats.sessions.filter(function (session) {
      return session.type === "focus" && dayKey(session.completedAt) === today;
    });
    var breaksToday = state.stats.sessions.filter(function (session) {
      return session.type === "break" && dayKey(session.completedAt) === today;
    });
    var minutes = focusToday.reduce(function (sum, session) { return sum + session.durationMs; }, 0) / 60000;
    els.statToday.textContent = String(focusToday.length);
    els.statMinutes.textContent = formatMinutes(minutes);
    els.statTotal.textContent = String(state.stats.sessions.filter(function (session) {
      return session.type === "focus";
    }).length);
    els.breakLine.textContent = breaksToday.length === 0
      ? "No breaks completed today"
      : (breaksToday.length === 1 ? "1 break completed today" : breaksToday.length + " breaks completed today");

    var start = new Date();
    start.setHours(0, 0, 0, 0);
    var days = [];
    for (var offset = 6; offset >= 0; offset -= 1) {
      var date = new Date(start);
      date.setDate(start.getDate() - offset);
      days.push(date);
    }
    var counts = days.map(function (date) {
      var key = dayKey(date.getTime());
      return state.stats.sessions.filter(function (session) {
        return session.type === "focus" && dayKey(session.completedAt) === key;
      }).length;
    });
    var max = Math.max.apply(null, counts.concat([1]));
    els.week.replaceChildren();
    days.forEach(function (date, index) {
      var count = counts[index];
      var li = document.createElement("li");
      if (dayKey(date.getTime()) === today) li.dataset.today = "true";
      var full = date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      var sessionWord = count === 1 ? "focus session" : "focus sessions";
      li.title = full + ": " + count + " " + sessionWord;

      var countEl = document.createElement("span");
      countEl.className = "bar-count";
      countEl.textContent = count ? String(count) : "";
      var track = document.createElement("span");
      track.className = "bar-track";
      var bar = document.createElement("span");
      bar.className = count ? "bar" : "bar is-empty";
      if (count) bar.style.height = Math.max(18, Math.round((count / max) * 100)) + "%";
      track.appendChild(bar);
      var dow = document.createElement("span");
      dow.className = "dow";
      dow.textContent = date.toLocaleDateString(undefined, { weekday: "narrow" });
      var sr = document.createElement("span");
      sr.className = "sr-only";
      sr.textContent = full + ", " + count + " " + sessionWord;
      li.append(countEl, track, dow, sr);
      els.week.appendChild(li);
    });
  }

  function renderAll() {
    renderTimer();
    renderSettings();
    renderPresets();
    renderHint();
    renderActive();
    renderTasks();
    renderStats();
    renderStorageNote();
  }

  function flashCard(finishedMode) {
    els.timerCard.classList.remove("flash-focus", "flash-break");
    void els.timerCard.offsetWidth;
    els.timerCard.classList.add(finishedMode === "break" ? "flash-break" : "flash-focus");
  }

  function ensureAudio() {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioCtx || audioCtx.state === "closed") {
      try { audioCtx = new AudioCtx(); } catch (err) { return null; }
    }
    return audioCtx;
  }

  function stopScheduledNodes() {
    var when = audioCtx ? audioCtx.currentTime : 0;
    scheduledNodes.forEach(function (node) {
      if (typeof node.stop === "function") {
        try { node.stop(when); } catch (err) { /* already stopped */ }
      }
      try { node.disconnect(); } catch (err) { /* already disconnected */ }
    });
    scheduledNodes = [];
    armedChimeRunId = null;
  }

  function spawnChime(ctx, when, track) {
    var nodes = [];
    var master = ctx.createGain();
    master.gain.setValueAtTime(0.85, when);
    var filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1600, when);
    master.connect(filter);
    filter.connect(ctx.destination);
    nodes.push(master, filter);
    [523.25, 659.25, 783.99, 1046.5].forEach(function (freq, index) {
      var startAt = when + index * 0.13;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.05, startAt + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.55);
      osc.connect(gain);
      gain.connect(master);
      osc.start(startAt);
      osc.stop(startAt + 0.58);
      nodes.push(osc, gain);
    });
    if (track) scheduledNodes = scheduledNodes.concat(nodes);
  }

  function playChime() {
    if (!state.settings.sound) return;
    var ctx = ensureAudio();
    if (!ctx) return;
    var fire = function () { spawnChime(ctx, ctx.currentTime + 0.03, false); };
    if (ctx.state === "suspended") ctx.resume().then(fire).catch(function () {});
    else fire();
  }

  function armEndChime() {
    if (!state.settings.sound || !state.timer.running || !state.timer.endsAt || !state.timer.runId) {
      stopScheduledNodes();
      return;
    }
    var ctx = audioCtx || ensureAudio();
    if (!ctx || ctx.state !== "running") return;
    if (armedChimeRunId === state.timer.runId && scheduledNodes.length) return;
    stopScheduledNodes();
    spawnChime(ctx, ctx.currentTime + Math.max(0, (state.timer.endsAt - Date.now()) / 1000), true);
    armedChimeRunId = state.timer.runId;
  }

  function primeAudioThenArm() {
    if (!state.settings.sound) {
      stopScheduledNodes();
      return;
    }
    var ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().then(function () { if (state.timer.running) armEndChime(); }).catch(function () {});
    } else {
      armEndChime();
    }
  }

  function startTicking() {
    if (tickTimer) clearInterval(tickTimer);
    tick();
    tickTimer = setInterval(tick, 200);
  }

  function stopTicking() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  function tick() {
    if (!state.timer.running || !state.timer.endsAt) return;
    var rem = state.timer.endsAt - Date.now();
    if (rem <= 0) {
      state.timer.remainingMs = 0;
      renderTimer();
      completeCurrentSession();
      return;
    }
    state.timer.remainingMs = rem;
    renderTimer();
    var key = dayKey(Date.now());
    if (key !== renderedDay) {
      renderedDay = key;
      els.todayLabel.textContent = formatLongDate(new Date());
      renderStats();
    }
  }

  function completeCurrentSession() {
    if (completing || !state.timer.running) return;
    completing = true;
    try {
      var mode = state.timer.mode;
      var runId = state.timer.runId;
      var endsAt = state.timer.endsAt;
      stopTicking();
      var already = runId && state.stats.sessions.some(function (session) { return session.runId === runId; });
      if (!already) {
        pushSession(state, {
          id: uid(),
          runId: runId || null,
          type: mode,
          completedAt: Math.min(Date.now(), Number.isFinite(endsAt) ? endsAt : Date.now()),
          durationMs: state.timer.durationMs,
          taskId: mode === "focus" ? state.activeTaskId : null
        });
        if (mode === "focus") creditTask(state, state.activeTaskId);
      }
      if (runId && armedChimeRunId === runId) {
        scheduledNodes = [];
        armedChimeRunId = null;
      } else {
        stopScheduledNodes();
        playChime();
      }
      armMode(state, mode === "focus" ? "break" : "focus");
      save();
      renderAll();
      flashCard(mode);
      showToast(mode === "focus" ? "Focus complete. Break is ready." : "Break complete. Ready when you are.");
    } finally {
      completing = false;
    }
  }

  function commitDurations() {
    var focusMin = clampMinutes(els.focusMin.value, state.settings.focusMin);
    var breakMin = clampMinutes(els.breakMin.value, state.settings.breakMin);
    els.focusMin.value = String(focusMin);
    els.breakMin.value = String(breakMin);
    state.settings.focusMin = focusMin;
    state.settings.breakMin = breakMin;
    if (sessionIsPristine()) {
      var ms = fullMs(state.timer.mode, state.settings);
      state.timer.durationMs = ms;
      state.timer.remainingMs = ms;
      state.timer.runId = null;
      state.timer.endsAt = null;
      state.timer.running = false;
    }
    save();
    renderTimer();
    renderSettings();
    renderHint();
    renderPresets();
  }

  function commitDurationsIfEdited() {
    var focusMin = clampMinutes(els.focusMin.value, state.settings.focusMin);
    var breakMin = clampMinutes(els.breakMin.value, state.settings.breakMin);
    var dirty = els.focusMin.value.trim() !== String(state.settings.focusMin)
      || els.breakMin.value.trim() !== String(state.settings.breakMin);
    if (dirty || focusMin !== state.settings.focusMin || breakMin !== state.settings.breakMin) commitDurations();
  }

  function startTimer() {
    if (state.timer.running || completing) return;
    commitDurationsIfEdited();
    if (state.timer.remainingMs <= 250) {
      var ms = fullMs(state.timer.mode, state.settings);
      state.timer.durationMs = ms;
      state.timer.remainingMs = ms;
    }
    if (!state.timer.runId) state.timer.runId = uid();
    state.timer.running = true;
    state.timer.endsAt = Date.now() + state.timer.remainingMs;
    primeAudioThenArm();
    startTicking();
    save();
    renderTimer();
    renderHint();
    announce(modeLabel(state.timer.mode) + " started. " + formatTime(state.timer.remainingMs) + " left.");
  }

  function pauseTimer() {
    if (!state.timer.running) return;
    var rem = state.timer.endsAt ? state.timer.endsAt - Date.now() : state.timer.remainingMs;
    if (rem <= 0) {
      state.timer.remainingMs = 0;
      completeCurrentSession();
      return;
    }
    state.timer.remainingMs = rem;
    state.timer.running = false;
    state.timer.endsAt = null;
    stopTicking();
    stopScheduledNodes();
    save();
    renderTimer();
    renderHint();
    announce("Paused at " + formatTime(state.timer.remainingMs) + ".");
  }

  function toggleTimer() {
    if (state.timer.running) pauseTimer();
    else startTimer();
  }

  function resetTimer() {
    if (completing) return;
    commitDurationsIfEdited();
    stopTicking();
    stopScheduledNodes();
    armMode(state, state.timer.mode);
    save();
    renderTimer();
    renderHint();
    announce(modeLabel(state.timer.mode) + " reset to " + formatTime(state.timer.remainingMs) + ".");
  }

  function setMode(mode) {
    if (mode !== "focus" && mode !== "break") return;
    if (state.timer.running) {
      if (mode !== state.timer.mode) showToast("Pause first to switch between focus and break.");
      return;
    }
    commitDurationsIfEdited();
    if (mode === state.timer.mode) return;
    stopScheduledNodes();
    armMode(state, mode);
    save();
    renderTimer();
    renderActive();
    renderHint();
    announce(modeLabel(mode) + " selected.");
  }

  function addTask() {
    var title = els.taskInput.value.trim().slice(0, 140);
    if (!title) {
      els.taskError.textContent = "Name the task before adding it.";
      els.taskError.hidden = false;
      els.taskInput.setAttribute("aria-invalid", "true");
      els.taskInput.classList.remove("invalid");
      void els.taskInput.offsetWidth;
      els.taskInput.classList.add("invalid");
      els.taskInput.focus();
      return;
    }
    if (state.tasks.length >= MAX_TASKS) {
      els.taskError.textContent = "The list holds 200 tasks. Delete one to add another.";
      els.taskError.hidden = false;
      els.taskInput.setAttribute("aria-invalid", "true");
      return;
    }
    els.taskError.hidden = true;
    els.taskInput.removeAttribute("aria-invalid");
    els.taskInput.classList.remove("invalid");
    var task = { id: uid(), title: title, done: false, pomodoros: 0, createdAt: Date.now() };
    state.tasks.push(task);
    state.activeTaskId = task.id;
    justAddedId = task.id;
    els.taskInput.value = "";
    save();
    renderTasks();
    renderActive();
    els.taskInput.focus();
    announce("Added " + title + ". It is the active task.");
  }

  function selectTask(id) {
    state.activeTaskId = state.activeTaskId === id ? null : id;
    save();
    renderTasks();
    renderActive();
    focusTaskControl(id, "select");
    var task = state.tasks.find(function (item) { return item.id === id; });
    if (task) announce(state.activeTaskId === id ? "Crediting " + task.title + "." : "Stopped crediting " + task.title + ".");
  }

  function toggleDone(id, done) {
    var task = state.tasks.find(function (item) { return item.id === id; });
    if (!task) return;
    task.done = done;
    save();
    renderTasks();
    renderActive();
    focusTaskControl(id, "toggle");
  }

  function deleteTask(id) {
    var index = state.tasks.findIndex(function (item) { return item.id === id; });
    if (index < 0) return;
    var task = state.tasks[index];
    state.tasks.splice(index, 1);
    var wasActive = state.activeTaskId === id;
    if (wasActive) state.activeTaskId = null;
    undo = { task: task, index: index, wasActive: wasActive };
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(function () { undo = null; }, 5000);
    save();
    renderTasks();
    renderActive();
    var next = state.tasks[index] || state.tasks[index - 1];
    if (next) focusTaskControl(next.id, "select");
    else els.taskInput.focus();
    showToast("Deleted “" + task.title + "”", { undo: true });
  }

  function undoDelete() {
    if (!undo) return;
    var entry = undo;
    undo = null;
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = null;
    state.tasks.splice(Math.min(entry.index, state.tasks.length), 0, entry.task);
    if (entry.wasActive) state.activeTaskId = entry.task.id;
    save();
    renderTasks();
    renderActive();
    showToast("Task restored");
  }

  function typingTarget(node) {
    if (!node || !node.tagName) return false;
    var tag = node.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(node.isContentEditable);
  }

  function persistSnapshot() {
    if (!state) return;
    if (state.timer.running && state.timer.endsAt) {
      var rem = state.timer.endsAt - Date.now();
      if (rem <= 0) {
        completeCurrentSession();
        return;
      }
      state.timer.remainingMs = rem;
    }
    save();
  }

  function adoptStoredState(awayNote) {
    stopTicking();
    stopScheduledNodes();
    renderAll();
    if (state.timer.running) {
      startTicking();
      armEndChime();
    }
    if (awayNote) showToast(awayNote);
  }

  function onDurationKey(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitDurations();
    event.target.blur();
  }

  function bind() {
    els.startBtn.addEventListener("click", startTimer);
    els.pauseBtn.addEventListener("click", pauseTimer);
    els.resetBtn.addEventListener("click", resetTimer);
    els.modeFocus.addEventListener("click", function () { setMode("focus"); });
    els.modeBreak.addEventListener("click", function () { setMode("break"); });
    els.focusMin.addEventListener("change", commitDurations);
    els.breakMin.addEventListener("change", commitDurations);
    els.focusMin.addEventListener("keydown", onDurationKey);
    els.breakMin.addEventListener("keydown", onDurationKey);

    document.querySelector(".durations").addEventListener("click", function (event) {
      var button = event.target.closest("[data-delta]");
      if (!button) return;
      var input = byId(button.getAttribute("data-target"));
      if (!input) return;
      var fallback = input === els.focusMin ? state.settings.focusMin : state.settings.breakMin;
      input.value = String(Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, clampMinutes(input.value, fallback) + Number(button.dataset.delta))));
      commitDurations();
    });

    els.presets.addEventListener("click", function (event) {
      var button = event.target.closest("[data-preset]");
      if (!button) return;
      var parts = button.dataset.preset.split(",");
      els.focusMin.value = parts[0];
      els.breakMin.value = parts[1];
      commitDurations();
    });

    els.sound.addEventListener("change", function () {
      state.settings.sound = els.sound.checked;
      if (!state.settings.sound) stopScheduledNodes();
      else {
        var ctx = ensureAudio();
        if (ctx && ctx.state === "suspended") ctx.resume().then(armEndChime).catch(function () {});
        else armEndChime();
      }
      save();
    });

    els.taskForm.addEventListener("submit", function (event) {
      event.preventDefault();
      addTask();
    });
    els.taskInput.addEventListener("input", function () {
      if (!els.taskInput.value.trim()) return;
      els.taskError.hidden = true;
      els.taskInput.removeAttribute("aria-invalid");
    });

    els.taskList.addEventListener("click", function (event) {
      var deleteBtn = event.target.closest('[data-action="delete"]');
      if (deleteBtn) {
        deleteTask(deleteBtn.dataset.taskId);
        return;
      }
      var selectBtn = event.target.closest('[data-action="select"]');
      if (selectBtn) selectTask(selectBtn.dataset.taskId);
    });
    els.taskList.addEventListener("change", function (event) {
      var input = event.target.closest('[data-action="toggle"]');
      if (input) toggleDone(input.dataset.taskId, input.checked);
    });

    document.addEventListener("keydown", function (event) {
      if (event.code !== "Space" || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      if (typingTarget(event.target)) return;
      event.preventDefault();
      toggleTimer();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") persistSnapshot();
      else if (state.timer.running) tick();
    });
    window.addEventListener("pagehide", persistSnapshot);
    window.addEventListener("pageshow", function (event) {
      if (!event.persisted) return;
      var loaded = readState();
      state = loaded.state;
      save();
      renderedDay = dayKey(Date.now());
      els.todayLabel.textContent = formatLongDate(new Date());
      adoptStoredState(loaded.awayNote);
    });
  }

  function init() {
    cacheElements();
    var loaded = readState();
    state = loaded.state;
    renderedDay = dayKey(Date.now());
    els.todayLabel.textContent = formatLongDate(new Date());
    els.progress.style.strokeDasharray = String(CIRC);
    bind();
    save();
    adoptStoredState(loaded.awayNote);
  }

  init();
})();

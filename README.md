<p align="center"><img src="mobile/assets/icon-only.png" width="120" alt="Cooked logo"></p>

<h1 align="center">Cooked.</h1>
<p align="center"><b>Active recall that gets you exam-ready.</b><br>Upload your modules → AI turns them into quizzes → you can't move on until you've mastered them.</p>

---

## What it does

- **Scans your modules:** PDF, PPTX, DOCX, images or text. AI reads every page *and diagram* and writes a reviewer plus a question bank.
- **6 question types:** multiple choice, true/false, identification, fill in the blank, enumeration, essay (AI-graded).
- **Mastery gating:** modules unlock one by one. Each question needs 3 correct answers in a row (spaced out), then a **Mastery Exam at 95%+** unlocks the next module.
- **🔑 Key points mode:** learn just the main term and idea of each topic, or pick exactly what your prof covered with **🎯 Scope**.
- **📅 Exam countdown:** set your exam date. A forgetting-curve model predicts how much you'll remember on exam day and times your reviews so it peaks then.
- **⚡ Boost:** your 15 weakest questions, repeated until they stick.
- **Rewards:** XP, combos, levels (Raw → Legendary Chef), daily streaks, 15 badges.
- **Resume anywhere:** switch tabs or close the app and pick up on the same question.

Built on the two study methods with the strongest research behind them: **practice testing** and **spaced practice** (Dunlosky et al., 2013), combined as *successive relearning*.

## ⬇️ Download

Get both from **[Releases → latest](../../releases/latest)**:

| Platform | File | Install |
|---|---|---|
| 🪟 Windows | **Cooked.exe** | Double-click. If SmartScreen shows, click *More info → Run anyway*. |
| 📱 Android | **Cooked.apk** | Open on your phone, allow "Install unknown apps" if asked. |

## 📱 Android app

1. Go to **[Releases](../../releases/latest)** and download **Cooked.apk** on your phone.
2. Open it and allow "Install unknown apps" if Android asks.
3. In the app: **⚙️ Settings** → paste a free Gemini key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

Everything runs on your phone. Your key and progress never leave it (only the module you scan is sent to Gemini).
Studying works offline. Scanning, essay grading and synonym checks need internet.

Cooked.exe and Cooked.apk are built automatically by GitHub Actions on every push (`.github/workflows/android.yml`).

## 💻 Desktop app (Windows)

Requires Python 3.10+.

```bash
cd desktop
python app.py
```

It opens in its own window and puts a **Cooked** shortcut on your Desktop. On the desktop you can scan with:
- **Gemini** (free key), or
- **Claude Pro** through Claude Code (Settings → Claude Pro → Connect).

**Send a subject to your phone:** desktop → open the subject → **📤 Export** → on the phone, subject → **⬇️ Import**.

## Project layout

```
desktop/   Python app (stdlib only) + web UI, Gemini / Claude Code scanning
mobile/    Android app (Capacitor): the same UI with an on-device engine (www/js/engine.js)
```

---
<p align="center">built by <b>dav</b></p>

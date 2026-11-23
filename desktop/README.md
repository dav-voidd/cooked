# Cooked 🔥
Active recall that gets you exam-ready. Upload your modules (PDF, PPTX, DOCX, images, TXT), Gemini reads every page and diagram, writes a full question bank, and you can't move to the next module until you've mastered the current one 100%.

## Run
- VS Code: open this folder, press **Ctrl+Shift+B** (or F5), or in the terminal: `python app.py`
- Or double-click **run.bat**

No pip installs needed (Python standard library only). It runs as a desktop app in its own native window (pywebview, auto-installed on first run). The first run also adds a **Cooked** icon to your Desktop and Start Menu, so after that you can launch it like any app.

## First time
1. Get a free key at https://aistudio.google.com/apikey
2. In Cooked: **Settings** → paste the key → **Test connection**
3. **Kitchen** → New subject → drop Module 1, 2, 3...

## Mastery rules (no loopholes)
- Each question must be answered right **3 times in a row**, spaced apart. One wrong = streak back to 0.
- Choices are reshuffled every time, so you can't memorize positions. Answers never reach the screen until you answer.
- When all questions are learned, the **Mastery Exam** unlocks: every question, shuffled, **100% required**. Notes are locked, quitting = fail. Missed questions must be re-learned before retrying.
- Passing unlocks the next module, and the mastered one moves into **spaced reviews** (10 min, 1, 3, 7, 16, 35, 90 days). If reviews are due, you must clear them before continuing new material.
- Question types: multiple choice, true/false, identification, fill in the blank, enumeration, essay (AI-graded against key points; 80+ needed).

## Rewards
XP per correct answer (higher for harder types), combo multiplier up to x2.5, exam x1.5, level ranks (Raw → Legendary Chef), daily streak, 15 badges, +500 XP (+250 first try) for mastering a module.

Your data lives in `data/` (delete it to reset).

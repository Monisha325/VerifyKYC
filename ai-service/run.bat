@echo off
REM PYTHONUTF8=1 must be set before Python starts — dotenv loads too late for this flag.
REM It prevents crashes from Unicode progress bars (EasyOCR, tqdm) on Windows cp1252 consoles.
set PYTHONUTF8=1
call .venv\Scripts\activate
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

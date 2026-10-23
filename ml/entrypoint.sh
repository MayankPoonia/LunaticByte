#!/bin/sh
# 1. If no data pack is mounted at all, generate the synthetic stand-in (devdata/).
# 2. Train the model unless artifacts already exist for the current labelled file (train.py --if-needed).
# 3. Serve with gunicorn (model loaded once per worker at start-up).
set -e
if ! ls /app/data/case_01_cards*.csv >/dev/null 2>&1 && ! ls /app/devdata/case_01_cards*.csv >/dev/null 2>&1; then
  echo "no data pack found in /app/data: generating synthetic stand-in data in /app/devdata"
  python /app/scripts/generate_synthetic_data.py /app/devdata
fi
python train.py --if-needed
exec gunicorn -w "${ML_WORKERS:-2}" -k gthread --threads "${ML_THREADS:-8}" -b "0.0.0.0:${PORT:-5000}" --access-logfile - app:app

#!/bin/sh
# Every start trains the model from scratch on the labelled CSV in /app/data, regenerates the
# evaluation report and model card, then serves it (the model is loaded once per worker).
set -e
python train.py
exec gunicorn -w "${ML_WORKERS:-2}" -k gthread --threads "${ML_THREADS:-8}" -b "0.0.0.0:${PORT:-5000}" --access-logfile - app:app
